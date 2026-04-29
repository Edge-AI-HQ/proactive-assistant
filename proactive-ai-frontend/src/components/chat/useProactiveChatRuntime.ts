/**
 * Custom ChatModelAdapter for the proactive-ai backend.
 *
 * POST /chat-stream/send returns an SSE stream:
 *   data: { type: "chat:thinking", ... }
 *   data: { type: "chat:delta", delta: "...", ... }
 *   data: { type: "chat:reply", content: "...", ... }
 *   data: { type: "chat:tool:start",  toolCallId, name, meta?, argsPreview?, pinCommand?, ... }
 *   data: { type: "chat:tool:update", toolCallId, name, ... }
 *   data: { type: "chat:tool:result", toolCallId, name, isError, meta?, ... }
 *   data: { type: "chat:error", error: "...", ... }
 *   data: { type: "chat:done", ... }
 *
 * The adapter yields accumulated content snapshots as required by assistant-ui.
 * Tool events are surfaced as `tool-call` content parts so the UI can render
 * the agent's current tool usage (e.g. exec / browser / pin CLI invocations)
 * inline with the streaming reply.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import {
  useLocalRuntime,
  type ChatModelAdapter,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { proxyFetch, proxyPost } from "@/lib/api";
import {
  buildChatRequestBody,
  shouldBootstrapCardChat,
} from "./card-chat-session";
import { LiveContentBuilder } from "./tool-steps";

export type { ProactiveToolCallArgs } from "./tool-steps";

interface UseProactiveChatRuntimeOptions {
  sessionKey: string;
  cardContext?: Record<string, unknown>;
}

interface AdapterOptions {
  sessionKey: string;
  cardContextJson?: string;
  bootstrappedSessionsRef: MutableRefObject<Set<string>>;
}

/**
 * OpenClaw forwards a `chat:error` event when its gateway is mid-restart —
 * after a model swap (config patch sends SIGUSR1), idle-wake, or admin
 * action. The agent run lane is drained for a few seconds and rejects new
 * tasks with `GatewayDrainingError` / `CommandLaneClearedError`, which the
 * plugin chat route surfaces verbatim. These are transient by nature, so
 * the SSE adapter retries the whole fetch instead of leaving the user
 * staring at an empty thread.
 */
function isTransientChatError(errMsg: string): boolean {
  return /gateway.*draining|draining.*gateway|command lane cleared/i.test(errMsg);
}

const MAX_TRANSIENT_RETRIES = 2;
const TRANSIENT_RETRY_BACKOFF_MS = 1500;

function createAdapter({
  sessionKey,
  cardContextJson,
  bootstrappedSessionsRef,
}: AdapterOptions): ChatModelAdapter {
  return {
    async *run({ messages, abortSignal }) {
      // Extract the latest user message text from the thread
      const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
      const userText = lastUserMsg?.content
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("\n");

      const needsBootstrap =
        Boolean(cardContextJson) &&
        !bootstrappedSessionsRef.current.has(sessionKey);

      // Card-chat bootstrap: when the thread is empty and we have card
      // context, we still run — the adapter produces the agent's first
      // turn from the card context alone. Otherwise (no user text, no
      // bootstrap) we have nothing to send.
      if (!userText && !needsBootstrap) {
        return;
      }

      const body = buildChatRequestBody({
        sessionKey,
        ...(userText ? { userText } : {}),
        cardContextJson,
        includeCardContext: needsBootstrap,
      });

      // Retry loop wraps the whole fetch + SSE parse so that a transient
      // chat:error (gateway draining for restart) starts over on a fresh
      // request — the in-flight stream is unrecoverable once the run lane
      // has been cleared. We only retry while the builder is still empty;
      // once any visible delta has streamed to the user, restarting from
      // scratch would feel jarring, so we surface the error instead.
      for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, TRANSIENT_RETRY_BACKOFF_MS * attempt));
        }
        if (abortSignal?.aborted) return;

        const res = await proxyFetch("/chat-stream/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: abortSignal,
        });

        if (!res.ok || !res.body) {
          throw new Error(`Chat stream failed: ${res.status}`);
        }

        const contentType = res.headers.get("content-type") || "";
        const isSSE = contentType.includes("text/event-stream");

        if (!isSSE) {
          // Fallback: legacy JSON response { ok, reply }
          const data = await res.json() as { ok?: boolean; reply?: string; error?: string };
          if (data.error) throw new Error(data.error);
          if (data.reply) {
            yield { content: [{ type: "text" as const, text: data.reply }] };
          }
          if (needsBootstrap) {
            bootstrappedSessionsRef.current.add(sessionKey);
          }
          return;
        }

        // SSE stream: read data: {...} lines
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        const builder = new LiveContentBuilder();
        let transient = false;

        sseLoop: while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const data = JSON.parse(line.slice(6)) as Record<string, unknown>;
              const type = data.type as string;

              if (type === "chat:delta") {
              const delta = typeof data.delta === "string" ? data.delta : "";
              if (delta) {
                builder.appendText(delta);
                yield { content: builder.snapshot() };
              }
            } else if (type === "chat:reply") {
              builder.replaceText(typeof data.content === "string" ? data.content : "");
              yield { content: builder.snapshot() };
            } else if (type === "chat:tool:start") {
              const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : "";
              const name = typeof data.name === "string" ? data.name : "";
              if (!toolCallId || !name) continue;
              builder.openToolCall({
                toolCallId,
                toolName: name,
                meta: typeof data.meta === "string" ? data.meta : undefined,
                argsPreview: typeof data.argsPreview === "string" ? data.argsPreview : undefined,
                pinCommand: typeof data.pinCommand === "string" ? data.pinCommand : undefined,
              });
              yield { content: builder.snapshot() };
            } else if (type === "chat:tool:result") {
              const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : "";
              if (!toolCallId) continue;
              builder.completeToolCall({
                toolCallId,
                isError: Boolean(data.isError),
                meta: typeof data.meta === "string" ? data.meta : undefined,
              });
              yield { content: builder.snapshot() };
            } else if (type === "chat:tool:update") {
              // Keep "running" state; no-op snapshot avoids unnecessary churn.
              continue;
            } else if (type === "chat:error") {
              const errMsg = typeof data.error === "string" ? data.error : "Unknown chat error";
              // Only retry while we haven't streamed anything visible yet
              // and budget remains. If the user has already seen partial
              // output, surface the error rather than silently restarting.
              if (
                isTransientChatError(errMsg) &&
                builder.isEmpty() &&
                attempt < MAX_TRANSIENT_RETRIES
              ) {
                transient = true;
                break sseLoop;
              }
              throw new Error(errMsg);
            }
            // chat:thinking and chat:done are handled implicitly.
            } catch (e) {
              if (e instanceof SyntaxError) continue;
              throw e;
            }
          }
        }

        if (transient) continue;

        if (!builder.isEmpty()) {
          yield { content: builder.snapshot() };
        }
        if (needsBootstrap) {
          bootstrappedSessionsRef.current.add(sessionKey);
        }
        return;
      }

      // Exhausted retries with transient errors
      throw new Error("Server is restarting, please try again in a moment.");
    },
  };
}

/**
 * Fetch existing chat history from the backend and convert to ThreadMessageLike[].
 *
 * Backend returns merged turns (see `chat-history-merge.ts`) with ordered
 * parts: user messages carry one text part; assistant messages carry a mix
 * of text and tool-call parts. We map directly into assistant-ui's
 * ThreadMessageLike content shape so tool-call parts flow through the same
 * rendering path as live SSE tool events (ToolActivityCard via
 * MessagePrimitive.Content `tools: { Fallback }`).
 */
interface HistoryTextPart {
  type: "text";
  text: string;
}

interface HistoryToolCallPart {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  status: "running" | "ok" | "error";
  meta?: string;
  argsPreview?: string;
  pinCommand?: string;
}

type HistoryPart = HistoryTextPart | HistoryToolCallPart;

interface HistoryMessage {
  id: string;
  role: "user" | "assistant";
  parts: HistoryPart[];
  createdAt?: number;
}

function toRuntimePart(part: HistoryPart) {
  if (part.type === "text") {
    return { type: "text" as const, text: part.text };
  }
  const args: Record<string, string> = { status: part.status };
  if (part.meta) args.meta = part.meta;
  if (part.argsPreview) args.argsPreview = part.argsPreview;
  if (part.pinCommand) args.pinCommand = part.pinCommand;
  return {
    type: "tool-call" as const,
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    args,
    argsText: JSON.stringify(args),
    ...(part.status === "running"
      ? {}
      : {
          result: { ok: part.status === "ok" },
          ...(part.status === "error" ? { isError: true as const } : {}),
        }),
  };
}

async function fetchHistory(sessionKey: string): Promise<ThreadMessageLike[]> {
  try {
    const histRes = await proxyFetch(
      `/chat-stream/history?sessionKey=${encodeURIComponent(sessionKey)}`,
    );
    const histData = await histRes.json();

    if (!histData.ok || !Array.isArray(histData.messages)) return [];

    return (histData.messages as HistoryMessage[]).map((m) => ({
      role: m.role,
      content: m.parts.map(toRuntimePart),
      ...(typeof m.createdAt === "number" && Number.isFinite(m.createdAt)
        ? { createdAt: new Date(m.createdAt) }
        : {}),
    }));
  } catch {
    return [];
  }
}

export function useProactiveChatRuntime(options: UseProactiveChatRuntimeOptions) {
  const [initialMessages, setInitialMessages] = useState<
    ThreadMessageLike[] | undefined
  >(undefined);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  // True once, when mount detected "card context + no history" — we hand off
  // to the adapter via runtime.thread.startRun so the first agent turn
  // streams through the same LiveContentBuilder path as regular messages.
  const [pendingBootstrap, setPendingBootstrap] = useState(false);
  const bootstrappedSessionsRef = useRef<Set<string>>(new Set());
  const triggeredBootstrapRef = useRef<Set<string>>(new Set());
  const cardContextJson = useMemo(
    () => (options.cardContext ? JSON.stringify(options.cardContext) : undefined),
    [options.cardContext],
  );

  useEffect(() => {
    let cancelled = false;
    setHistoryLoaded(false);
    setInitialMessages(undefined);
    setPendingBootstrap(false);

    void (async () => {
      try {
        const initRes = await proxyPost("/chat-stream/init", {
          sessionKey: options.sessionKey,
        });
        const initData = await initRes.json() as { ok?: boolean; existing?: boolean };
        const hasExistingHistory = Boolean(initData.ok && initData.existing);

        if (hasExistingHistory) {
          bootstrappedSessionsRef.current.add(options.sessionKey);
        }

        const msgs = await fetchHistory(options.sessionKey);
        if (cancelled) return;
        if (msgs.length > 0) {
          bootstrappedSessionsRef.current.add(options.sessionKey);
        }
        setInitialMessages(msgs.length > 0 ? msgs : undefined);

        const shouldBootstrap = shouldBootstrapCardChat({
          hasExistingHistory: hasExistingHistory || msgs.length > 0,
          hasCardContext: Boolean(cardContextJson),
          alreadyBootstrapped: bootstrappedSessionsRef.current.has(options.sessionKey),
        });
        if (shouldBootstrap) {
          setPendingBootstrap(true);
        }
      } catch {
        if (cancelled) return;
        setInitialMessages(undefined);
      } finally {
        if (!cancelled) {
          setHistoryLoaded(true);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [cardContextJson, options.sessionKey]);

  const adapter = useMemo(
    () =>
      createAdapter({
        sessionKey: options.sessionKey,
        cardContextJson,
        bootstrappedSessionsRef,
      }),
    [cardContextJson, options.sessionKey],
  );
  const runtime = useLocalRuntime(adapter, { initialMessages });

  // Once the runtime is mounted and the thread is confirmed empty,
  // kick off an agent-only run so the first card-chat message streams
  // into the UI in real time (rather than landing as a static bubble
  // after a silent pre-fetch).
  useEffect(() => {
    if (!pendingBootstrap || !historyLoaded) return;
    if (triggeredBootstrapRef.current.has(options.sessionKey)) return;

    // Defer startRun to the next macrotask so React's commit phase
    // (including StrictMode dev's setup→cleanup→setup pair) and
    // useLocalRuntime's internal LocalThreadRuntimeCore detach→reattach
    // both settle first. Without this, the synchronous startRun lands on
    // a thread runtime that's about to be detached, the in-flight fetch
    // is aborted, and the wedged ref marker prevents any re-trigger.
    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;
      triggeredBootstrapRef.current.add(options.sessionKey);
      try {
        runtime.thread.startRun({ parentId: null });
      } catch (error) {
        console.warn("[Chat] startRun for card bootstrap failed:", error);
      }
      setPendingBootstrap(false);
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [pendingBootstrap, historyLoaded, options.sessionKey, runtime]);

  return { runtime, historyLoaded };
}
