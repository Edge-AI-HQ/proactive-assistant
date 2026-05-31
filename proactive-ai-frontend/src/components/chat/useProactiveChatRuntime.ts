/**
 * Custom ChatModelAdapter for the proactive-ai backend.
 *
 * POST /chat-stream/send returns an SSE stream:
 *   data: { type: "chat:thinking", ... }                   // stream open signal
 *   data: { type: "chat:reasoning:delta", delta: "..." }    // extended thinking
 *   data: { type: "chat:delta", delta: "...", ... }         // final answer text
 *   data: { type: "chat:reply", content: "...", ... }
 *   data: { type: "chat:tool:start",  toolCallId, name, meta?, argsPreview?, pinCommand?, ... }
 *   data: { type: "chat:tool:update", toolCallId, name, ... }
 *   data: { type: "chat:tool:result", toolCallId, name, isError, meta?, ... }
 *   data: { type: "chat:error", error: "...", ... }
 *   data: { type: "chat:done", ... }
 *
 * The adapter yields accumulated content snapshots as required by assistant-ui.
 * `reasoning` parts surface Claude's extended-thinking content and render
 * before the final assistant text. Tool events surface as `tool-call` parts.
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
  buildRequestUserText,
  shouldIncludeCardContext,
  shouldBootstrapCardChat,
  stripRequestOnlyCardContext,
} from "./card-chat-session";
import { LiveContentBuilder, type JsonValue } from "./tool-steps";
import { parseTodosFromArgs, setTodos } from "./todos-store";
import { useClientHints, type ClientHints } from "@/hooks/useClientHints";

export type { ProactiveToolCallArgs } from "./tool-steps";

interface UseProactiveChatRuntimeOptions {
  sessionKey: string;
  cardContext?: Record<string, unknown>;
  // Non-empty → adapter auto-fires on mount as if the user typed this
  // (fresh thread only). Used by the card "Confirm" path to send the
  // primaryAction text as the user's first turn. Card "Chat" path
  // (just open, let user type) leaves this undefined.
  bootstrapMessage?: string;
}

interface AdapterOptions {
  sessionKey: string;
  cardContext?: Record<string, unknown>;
  bootstrapMessage?: string;
  bootstrappedSessionsRef: MutableRefObject<Set<string>>;
  /** Latest device hints — read via ref at send time so resizes flow
   *  through without rebuilding the adapter. */
  clientHintsRef: MutableRefObject<ClientHints | null>;
  /** Total message count the runtime had on the previous adapter
   *  invocation. We compare against the current `messages.length` to
   *  decide whether this turn is a fresh send (count grew → a new
   *  user msg was appended) or a Regenerate / Edit (count stayed
   *  same / shrunk → assistant-ui dropped the trailing assistant before
   *  re-invoking us). On Regenerate / Edit we pass `regenerate=true`
   *  to the backend so it pops the stale AI / Tool messages from
   *  LangGraph state (and replaces the trailing HumanMessage if the
   *  user edited it) instead of appending duplicate turns. */
  lastSeenMessageCountRef: MutableRefObject<number>;
}

/**
 * Backend transient errors during chat-stream/send. Rare path — the chat
 * worker emits a `chat:error` event when its sandbox provisioning blips
 * mid-stream and the run state is unrecoverable in place. Retrying the
 * whole fetch (cheap) is preferable to surfacing a half-empty thread.
 */
function isTransientChatError(errMsg: string): boolean {
  return /sandbox.*(provisioning|unavailable)|temporarily unavailable/i.test(
    errMsg,
  );
}

const MAX_TRANSIENT_RETRIES = 2;
const TRANSIENT_RETRY_BACKOFF_MS = 1500;

function createAdapter({
  sessionKey,
  cardContext,
  bootstrapMessage,
  bootstrappedSessionsRef,
  clientHintsRef,
  lastSeenMessageCountRef,
}: AdapterOptions): ChatModelAdapter {
  return {
    async *run({ messages, abortSignal }) {
      // Extract the latest user message text from the thread
      const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
      const userText = lastUserMsg?.content
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("\n");

      // Regenerate / Edit detection: when assistant-ui drops the trailing
      // assistant (Reload, beginEdit-submit, startRun(parentId=user.id))
      // and re-invokes the adapter, the messages array's length doesn't
      // grow (it either stays the same — in-place edit / placeholder
      // swap — or shrinks). When the user types a brand-new message,
      // length grows by 1+. We compare against the previous-seen count
      // (initialized from history on mount, see useEffect below).
      const prevCount = lastSeenMessageCountRef.current;
      const isRegenerate = prevCount > 0 && messages.length <= prevCount;
      lastSeenMessageCountRef.current = messages.length;

      // "Fresh thread" means: first turn after init, no prior user turn
      // in this runtime instance. It still gates bootstrap-message firing.
      // Card-context inclusion is decided below: card threads keep their
      // one-shot behavior, while main chat carries card context on every
      // card-feedback turn because the main thread is a per-user singleton.
      const isFreshThread =
        (Boolean(cardContext) || Boolean(bootstrapMessage?.trim())) &&
        !bootstrappedSessionsRef.current.has(sessionKey);

      // Bootstrap: caller-provided `bootstrapMessage` (card primaryAction
      // on Confirm, or Main Chat's chip / composer entry) gets sent as
      // if the user typed it. Without it, an empty thread + no user
      // text means the user just opened a fresh Chat — bail out and
      // wait for them to type.
      const effectiveText = userText || (isFreshThread ? bootstrapMessage : undefined);
      if (!effectiveText) {
        return;
      }

      const body = buildChatRequestBody({
        sessionKey,
        userText: buildRequestUserText({
          sessionKey,
          userText: effectiveText,
          cardContext,
        }),
        cardContext,
        includeCardContext: shouldIncludeCardContext({
          hasCardContext: Boolean(cardContext),
          isFreshThread,
          sessionKey,
        }),
        clientHints: clientHintsRef.current ?? undefined,
      });
      if (isRegenerate) {
        // Backend ignores `message` when regenerate=true; we keep
        // sending it (harmless) so request shape stays consistent.
        body.regenerate = true;
      }

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
          if (isFreshThread) {
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
              // Unified SSE envelope (Step 3): event payload lives under
              // `data.data`. Tolerate flat shape too in case some emitter
              // hasn't migrated yet.
              const payload = (
                (data.data && typeof data.data === "object")
                  ? (data.data as Record<string, unknown>)
                  : data
              );

              if (type === "chat:delta") {
              const delta = typeof payload.delta === "string" ? payload.delta : "";
              if (delta) {
                builder.appendText(delta);
                yield { content: builder.snapshot() };
              }
            } else if (type === "chat:reasoning:delta") {
              const delta = typeof payload.delta === "string" ? payload.delta : "";
              if (delta) {
                builder.appendReasoning(delta);
                yield { content: builder.snapshot() };
              }
            } else if (type === "chat:reply") {
              builder.replaceText(typeof payload.content === "string" ? payload.content : "");
              yield { content: builder.snapshot() };
            } else if (type === "chat:tool:start") {
              const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : "";
              const name = typeof payload.name === "string" ? payload.name : "";
              if (!toolCallId || !name) continue;
              builder.openToolCall({
                toolCallId,
                toolName: name,
                meta: typeof payload.meta === "string" ? payload.meta : undefined,
                argsPreview: typeof payload.argsPreview === "string" ? payload.argsPreview : undefined,
                pinCommand: typeof payload.pinCommand === "string" ? payload.pinCommand : undefined,
                // Full structured input — present when the tool's args
                // fit under streaming.py's 8 KB cap. Threaded into
                // ProposeActionCard / TodoPanel which render specialized
                // UI from the raw payload instead of parsing the
                // truncated argsPreview string. The SSE wire already
                // sends JSON, so the cast is safe.
                input: payload.args as JsonValue | undefined,
              });
              // write_todos: feed structured plan to the side-panel store.
              // The agent re-emits the whole list on every state change
              // (langchain TodoListMiddleware uses Command.update with full
              // replacement), so a simple write here keeps the UI in sync —
              // no merge/diff logic needed.
              if (name === "write_todos") {
                const todos = parseTodosFromArgs(payload.args);
                if (todos) setTodos(sessionKey, todos);
              }
              yield { content: builder.snapshot() };
            } else if (type === "chat:tool:result") {
              const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : "";
              if (!toolCallId) continue;
              builder.completeToolCall({
                toolCallId,
                isError: Boolean(payload.isError),
                meta: typeof payload.meta === "string" ? payload.meta : undefined,
              });
              yield { content: builder.snapshot() };
            } else if (type === "chat:tool:update") {
              // Keep "running" state; no-op snapshot avoids unnecessary churn.
              continue;
            } else if (type === "chat:error") {
              const errMsg = typeof payload.error === "string" ? payload.error : "Unknown chat error";
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
        if (isFreshThread) {
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
 * rendering path as live SSE tool events (ChatToolGroup, grouped inside
 * AssistantMessage by manual iteration over `m.content`).
 */
interface HistoryTextPart {
  type: "text";
  text: string;
}

interface HistoryReasoningPart {
  type: "reasoning";
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
  /** Full structured tool input, when JSON-serializable and under the
   *  backend's 8 KB cap (see chat/routes/history.py `_safe_args_full`).
   *  Threaded into the runtime tool-call part's `args.input` so
   *  specialized renderers (ProposeActionCard) can read the typed
   *  payload during history replay just like they do off live SSE. */
  args?: unknown;
}

type HistoryPart = HistoryTextPart | HistoryReasoningPart | HistoryToolCallPart;

interface HistoryMessage {
  id: string;
  role: "user" | "assistant";
  parts: HistoryPart[];
  createdAt?: number;
}

function toRuntimePart(part: HistoryPart) {
  if (part.type === "text") {
    return { type: "text" as const, text: stripRequestOnlyCardContext(part.text) };
  }
  if (part.type === "reasoning") {
    return { type: "reasoning" as const, text: part.text };
  }
  const args: Record<string, JsonValue> = { status: part.status };
  if (part.meta) args.meta = part.meta;
  if (part.argsPreview) args.argsPreview = part.argsPreview;
  if (part.pinCommand) args.pinCommand = part.pinCommand;
  if (part.args !== undefined) args.input = part.args as JsonValue;
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
  // Tracks the runtime `messages.length` we last sent for — adapter
  // compares against the current length to distinguish "fresh send"
  // (count grew) from "Regenerate / Edit" (count stayed / shrunk).
  const lastSeenMessageCountRef = useRef<number>(0);
  // Latest device hints — kept in a ref so resize-driven re-renders
  // don't force the adapter to rebuild every turn.
  const clientHints = useClientHints();
  const clientHintsRef = useRef<ClientHints | null>(null);
  clientHintsRef.current = clientHints;
  // Stable string view of the card context for use as a memo / effect dep.
  // The hook receives `options.cardContext` as an object whose identity may
  // change every render even when the content is the same — using the
  // serialized form as the dep avoids re-running effects on every render.
  const cardContextJson = useMemo(
    () => (options.cardContext ? JSON.stringify(options.cardContext) : undefined),
    [options.cardContext],
  );

  useEffect(() => {
    let cancelled = false;
    setHistoryLoaded(false);
    setInitialMessages(undefined);
    setPendingBootstrap(false);
    // Reset for the new session — stale count from a prior thread would
    // otherwise mis-trigger regenerate detection on this thread's
    // first send.
    lastSeenMessageCountRef.current = 0;

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
          bootstrapMessage: options.bootstrapMessage,
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
        cardContext: options.cardContext,
        bootstrapMessage: options.bootstrapMessage,
        bootstrappedSessionsRef,
        clientHintsRef,
        lastSeenMessageCountRef,
      }),
    // cardContextJson is the string-stable dep — the closure reads the
    // current options.cardContext object at the time the memo recomputes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cardContextJson, options.sessionKey, options.bootstrapMessage],
  );
  const runtime = useLocalRuntime(adapter, { initialMessages });

  // After history first loads into the runtime, seed
  // lastSeenMessageCountRef from the runtime's initial message count.
  // Without this, the first Regenerate / Edit click after a fresh page
  // load would look like a brand-new send (prevCount=0 → fresh) and
  // the backend would append a duplicate HumanMessage.
  useEffect(() => {
    if (!historyLoaded) return;
    lastSeenMessageCountRef.current = runtime.thread.getState().messages.length;
  }, [historyLoaded, runtime]);

  // Once the runtime is mounted and the thread is confirmed empty,
  // append the bootstrap message as a user turn — assistant-ui then
  // auto-fires the run, so the user bubble is visible in the UI and
  // the agent's reply streams in below it. (Previously this used
  // `startRun({parentId: null})` which drove the same backend flow
  // but skipped adding the user message to the runtime's state, so
  // no user bubble ever rendered. CardChat's "Confirm" path also
  // benefits from showing the user's action as a bubble.)
  useEffect(() => {
    if (!pendingBootstrap || !historyLoaded) return;
    if (triggeredBootstrapRef.current.has(options.sessionKey)) return;
    const text = options.bootstrapMessage?.trim();
    if (!text) {
      setPendingBootstrap(false);
      return;
    }

    // Defer to the next macrotask so React's commit phase (including
    // StrictMode dev's setup→cleanup→setup pair) and useLocalRuntime's
    // internal LocalThreadRuntimeCore detach→reattach both settle first.
    // Without this, the synchronous append lands on a thread runtime
    // that's about to be detached, the in-flight fetch is aborted, and
    // the wedged ref marker prevents any re-trigger.
    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;
      triggeredBootstrapRef.current.add(options.sessionKey);
      try {
        void runtime.thread.append({
          role: "user",
          content: [{ type: "text", text }],
        });
      } catch (error) {
        console.warn("[Chat] append for bootstrap failed:", error);
      }
      setPendingBootstrap(false);
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    pendingBootstrap,
    historyLoaded,
    options.sessionKey,
    options.bootstrapMessage,
    runtime,
  ]);

  // History view-gating: true once history has loaded with at least one prior
  // message. Callers use it to skip the empty-state landing (the orb) and show
  // the transcript directly — the orb is only for a fresh, empty thread.
  const hasHistory = (initialMessages?.length ?? 0) > 0;

  return { runtime, historyLoaded, hasHistory };
}
