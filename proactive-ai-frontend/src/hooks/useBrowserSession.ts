/**
 * Browser session SSE + control surface for one chat thread.
 *
 * Owns:
 *   - long-lived SSE to `/browser/events?sessionKey=...` with auto-reconnect
 *   - the `BrowserSession` reducer (opened / closed / navigated /
 *     control:granted / control:takeover envelopes)
 *   - heartbeat ping while user is driving
 *
 * Exposes a small set of imperative actions (control / input / refresh /
 * close) so the BrowserPanel doesn't talk to the API directly.
 *
 * Lifetime is tied to the chat thread (sessionKey). Session lifecycle is
 * decoupled from chat-stream/send: the SSE connection stays open across
 * many chat turns and survives backgrounding (iframe reload key is
 * bumped by the parent on visibility change; we re-fetch the live-view
 * URL first so the new iframe gets a fresh signed token).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { proxyFetch, proxyPost } from "@/lib/api";

export type BrowserControlMode = "ai" | "user";
export type BrowserDeviceKind = "mobile" | "tablet" | "desktop";

export interface BrowserSession {
  sessionKey: string;
  bbSessionId: string;
  liveViewUrl: string;
  viewport: { width: number; height: number };
  /** Stealth UA profile the remote browser was launched with. Drives
   *  whether the live-view iframe is rendered fit-to-width (mobile /
   *  tablet — wants natural vertical scroll) or fit-to-height (desktop
   *  — wants the full chrome visible). Defaults to "desktop" on the
   *  legacy code path that never emits it. */
  deviceKind: BrowserDeviceKind;
  controlMode: BrowserControlMode;
  /** Set by AI calling `request_takeover`; cleared when control returns to AI. */
  takeoverReason: string | null;
  currentUrl: string;
}

interface BrowserEnvelope {
  type: string;
  data?: Record<string, unknown>;
}

function parseControlMode(value: unknown): BrowserControlMode {
  return value === "user" ? "user" : "ai";
}

function parseDeviceKind(value: unknown): BrowserDeviceKind {
  return value === "mobile" || value === "tablet" ? value : "desktop";
}

function reduce(
  prev: BrowserSession | null,
  ev: BrowserEnvelope,
): BrowserSession | null {
  const data = (ev.data ?? {}) as Record<string, unknown>;
  switch (ev.type) {
    case "browser:opened": {
      const sessionKey = String(data.sessionKey ?? "");
      const bbSessionId = String(data.bbSessionId ?? "");
      const liveViewUrl = String(data.liveViewUrl ?? "");
      if (!sessionKey || !bbSessionId) return prev;
      const viewport =
        (data.viewport as { width: number; height: number }) ?? { width: 1280, height: 720 };
      return {
        sessionKey,
        bbSessionId,
        liveViewUrl,
        viewport,
        deviceKind: parseDeviceKind(data.deviceKind),
        controlMode: parseControlMode(data.controlMode),
        takeoverReason:
          typeof data.takeoverReason === "string" && data.takeoverReason
            ? data.takeoverReason
            : null,
        currentUrl: typeof data.url === "string" ? data.url : "",
      };
    }
    case "browser:closed":
      return null;
    case "browser:navigated":
      if (!prev) return prev;
      return { ...prev, currentUrl: typeof data.url === "string" ? data.url : prev.currentUrl };
    case "browser:control:granted":
    case "browser:control:takeover": {
      if (!prev) return prev;
      const mode = parseControlMode(data.controlMode);
      const reason = typeof data.reason === "string" && data.reason ? data.reason : null;
      return {
        ...prev,
        controlMode: mode,
        takeoverReason: ev.type === "browser:control:takeover" ? reason : null,
      };
    }
    default:
      return prev;
  }
}

function parseSSEBuffer(
  buffer: string,
  onEnvelope: (env: BrowserEnvelope) => void,
): string {
  const lines = buffer.split("\n");
  const remainder = lines.pop() || "";
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    try {
      onEnvelope(JSON.parse(line.slice(6)) as BrowserEnvelope);
    } catch {
      /* skip non-JSON */
    }
  }
  return remainder;
}

export interface UseBrowserSessionResult {
  session: BrowserSession | null;
  setControl: (mode: BrowserControlMode, reason?: string) => Promise<void>;
  sendInput: (input: BrowserInput) => Promise<void>;
  refreshLiveView: () => Promise<void>;
  close: () => Promise<void>;
}

export type BrowserInput =
  | { type: "text"; text: string }
  | { type: "key"; key: string }
  | { type: "click"; x: number; y: number }
  | { type: "scroll"; dx: number; dy: number }
  | { type: "navigate"; url: string }
  | { type: "back" }
  | { type: "forward" }
  | { type: "reload" };

const HEARTBEAT_INTERVAL_MS = 25_000;
const RECONNECT_BACKOFF_MS = 1500;

export function useBrowserSession(sessionKey: string): UseBrowserSessionResult {
  const [session, setSession] = useState<BrowserSession | null>(null);
  const sessionRef = useRef<BrowserSession | null>(null);
  sessionRef.current = session;

  // ── SSE auto-reconnect loop ──
  useEffect(() => {
    let cancelled = false;
    let activeController: AbortController | null = null;

    const handle = (env: BrowserEnvelope) => {
      setSession((prev) => reduce(prev, env));
    };

    const connect = async () => {
      while (!cancelled) {
        const controller = new AbortController();
        activeController = controller;
        try {
          const res = await proxyFetch(
            `/browser/events?sessionKey=${encodeURIComponent(sessionKey)}`,
            { signal: controller.signal },
          );
          if (!res.ok || !res.body) {
            throw new Error(`SSE ${res.status}`);
          }
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          while (!cancelled) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            buffer = parseSSEBuffer(buffer, handle);
          }
        } catch (err) {
          if (controller.signal.aborted || cancelled) return;
          console.warn("[useBrowserSession] SSE dropped, reconnecting:", err);
        }
        if (cancelled) return;
        await new Promise((r) => setTimeout(r, RECONNECT_BACKOFF_MS));
      }
    };
    void connect();
    return () => {
      cancelled = true;
      activeController?.abort();
    };
  }, [sessionKey]);

  // ── Heartbeat while user is driving — keeps the chat-side idle GC
  //    from yanking the session out from under them. ──
  useEffect(() => {
    if (!session || session.controlMode !== "user") return;
    const ping = () => {
      void proxyPost(
        `/browser/sessions/${encodeURIComponent(session.sessionKey)}/heartbeat`,
        {},
      );
    };
    ping();
    const t = window.setInterval(ping, HEARTBEAT_INTERVAL_MS);
    return () => window.clearInterval(t);
  }, [session?.sessionKey, session?.controlMode]);

  // ── Imperative actions ──
  const setControl = useCallback(
    async (mode: BrowserControlMode, reason?: string) => {
      const cur = sessionRef.current;
      if (!cur) return;
      // Optimistic local update so the UI is snappy; SSE replays the
      // server-confirmed state on the next envelope.
      setSession({ ...cur, controlMode: mode, takeoverReason: mode === "user" ? reason ?? null : null });
      await proxyPost(
        `/browser/sessions/${encodeURIComponent(cur.sessionKey)}/control`,
        reason ? { mode, reason } : { mode },
      );
    },
    [],
  );

  const sendInput = useCallback(async (input: BrowserInput) => {
    const cur = sessionRef.current;
    if (!cur) return;
    const res = await proxyPost(
      `/browser/sessions/${encodeURIComponent(cur.sessionKey)}/input`,
      input,
    );
    if (res.status === 404) {
      // Session is gone — drop local state so the panel unmounts.
      setSession(null);
    }
  }, []);

  const refreshLiveView = useCallback(async () => {
    const cur = sessionRef.current;
    if (!cur) return;
    await proxyPost(
      `/browser/sessions/${encodeURIComponent(cur.sessionKey)}/refresh-live-view`,
      {},
    );
    // Backend emits a fresh browser:opened on the SSE bus with the new
    // liveViewUrl; the reducer picks it up. No local optimistic update.
  }, []);

  const close = useCallback(async () => {
    const cur = sessionRef.current;
    if (!cur) return;
    setSession(null);
    await proxyFetch(
      `/browser/sessions/${encodeURIComponent(cur.sessionKey)}`,
      { method: "DELETE" },
    );
  }, []);

  return { session, setControl, sendInput, refreshLiveView, close };
}
