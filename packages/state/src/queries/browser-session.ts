/**
 * Browser session SSE + control surface for one chat thread. 平台无关 hook,
 * web / RN 共用(SSE 走 core transport 注入的 fetch —— RN 注入 expo/fetch 提供
 * 流式 body)。状态机 reduce + 类型在 @pin-ai/core(domain/browser-session)。
 *
 * Owns:
 *   - long-lived SSE to `/browser/events?sessionKey=...` with auto-reconnect
 *   - heartbeat ping while user is driving
 *   - a small set of imperative actions(control / input / refresh / close)
 *
 * Lifetime is tied to the chat thread (sessionKey). The SSE connection stays
 * open across many chat turns and survives backgrounding.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  hostFromUrl,
  proxyFetch,
  proxyPost,
  reduceBrowserSession,
  type BrowserControlMode,
  type BrowserEnvelope,
  type BrowserInput,
  type BrowserSession,
} from "@pin-ai/core";

export interface UseBrowserSessionResult {
  session: BrowserSession | null;
  /** UI visibility of the browser panel, decoupled from session existence.
   *  A session can exist (browser_tool opened one) while the panel stays
   *  closed — the user opens it from the input-bar header. */
  panelOpen: boolean;
  openPanel: () => void;
  /** Collapse the panel back to the header without destroying the session. */
  closePanel: () => void;
  setControl: (mode: BrowserControlMode, reason?: string) => Promise<void>;
  /** Forward a user input event. Returns the backend's JSON (e.g. `tap`
   *  returns `{editableFocused}`) or null when there's no session / 404. */
  sendInput: (input: BrowserInput) => Promise<Record<string, unknown> | null>;
  refreshLiveView: () => Promise<void>;
  /** Destroy the remote session (which also closes the panel). */
  close: () => Promise<void>;
}

const HEARTBEAT_INTERVAL_MS = 25_000;
const RECONNECT_BACKOFF_MIN_MS = 1500;
const RECONNECT_BACKOFF_MAX_MS = 30_000;

/** SSE 行缓冲解析(hook plumbing):切出整行 `data: ` envelope,残行回传下次拼接。 */
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

export function useBrowserSession(sessionKey: string): UseBrowserSessionResult {
  const [session, setSession] = useState<BrowserSession | null>(null);
  const sessionRef = useRef<BrowserSession | null>(null);
  sessionRef.current = session;

  // Panel visibility is the user's choice, NOT a function of session
  // existence: browser_tool opening a session must not pop the panel open
  // (the user opens it from the input-bar header). A session going away,
  // though, always closes the panel.
  const [panelOpen, setPanelOpen] = useState(false);
  useEffect(() => {
    if (!session) setPanelOpen(false);
  }, [session]);
  const openPanel = useCallback(() => setPanelOpen(true), []);
  const closePanel = useCallback(() => setPanelOpen(false), []);

  // ── SSE auto-reconnect loop ──
  useEffect(() => {
    let cancelled = false;
    let activeController: AbortController | null = null;

    const handle = (env: BrowserEnvelope) => {
      setSession((prev) => reduceBrowserSession(prev, env));
    };

    const connect = async () => {
      let backoff = RECONNECT_BACKOFF_MIN_MS;
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
            // 收到任何数据即证明连接可用 → 退避重置回 min（防「连上即断」的抖动被指数放大）。
            backoff = RECONNECT_BACKOFF_MIN_MS;
            buffer += decoder.decode(value, { stream: true });
            buffer = parseSSEBuffer(buffer, handle);
          }
        } catch (err) {
          if (controller.signal.aborted || cancelled) return;
          console.warn("[useBrowserSession] SSE dropped, reconnecting:", err);
        }
        if (cancelled) return;
        // 指数退避（1.5s → 3s → … → 30s 封顶）：持续失败时不再每 1.5s 硬重连打耗电。
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, RECONNECT_BACKOFF_MAX_MS);
      }
    };
    void connect();
    return () => {
      cancelled = true;
      activeController?.abort();
    };
  }, [sessionKey]);

  // ── Heartbeat while user is driving — keeps the chat-side idle GC from
  //    yanking the session out from under them. ──
  useEffect(() => {
    if (!session || session.controlMode !== "user") return;
    const ping = () => {
      void proxyPost(
        `/browser/sessions/${encodeURIComponent(session.sessionKey)}/heartbeat`,
        {},
      );
    };
    ping();
    const t = setInterval(ping, HEARTBEAT_INTERVAL_MS);
    return () => clearInterval(t);
  }, [session?.sessionKey, session?.controlMode]);

  // ── Record sites the user manually operates while driving (user-control
  //    mode = they're almost always logging in). Powers the data-connector
  //    "网站登录" list. Dedup by host within the hook lifetime; the backend
  //    upsert is idempotent so a re-touch just bumps last_used_at. ──
  const recordedHostRef = useRef<string | null>(null);
  useEffect(() => {
    if (!session || session.controlMode !== "user") return;
    const host = hostFromUrl(session.currentUrl);
    if (!host || host === recordedHostRef.current) return;
    recordedHostRef.current = host;
    // Backend asks chat whether the page actually has a login cookie before
    // recording, so merely browsing a site (no login) won't add it.
    void proxyPost("/browser/logins/record", { sessionKey: session.sessionKey });
  }, [session?.controlMode, session?.currentUrl]);

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

  const sendInput = useCallback(
    async (input: BrowserInput): Promise<Record<string, unknown> | null> => {
      const cur = sessionRef.current;
      if (!cur) return null;
      const res = await proxyPost(
        `/browser/sessions/${encodeURIComponent(cur.sessionKey)}/input`,
        input,
      );
      if (res.status === 404) {
        // Session is gone — drop local state so the panel unmounts.
        setSession(null);
        return null;
      }
      try {
        return (await res.json()) as Record<string, unknown>;
      } catch {
        return null;
      }
    },
    [],
  );

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

  return {
    session,
    panelOpen,
    openPanel,
    closePanel,
    setControl,
    sendInput,
    refreshLiveView,
    close,
  };
}
