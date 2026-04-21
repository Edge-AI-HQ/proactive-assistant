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
import {
  buildContentSnapshot,
  type ProactiveToolStep,
} from "./tool-steps";

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

async function bootstrapCardChatSession(
  sessionKey: string,
  cardContextJson: string,
): Promise<void> {
  const res = await proxyFetch("/chat-stream/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      buildChatRequestBody({
        sessionKey,
        cardContextJson,
        includeCardContext: true,
      }),
    ),
  });

  if (!res.ok || !res.body) {
    throw new Error(`Card chat bootstrap failed: ${res.status}`);
  }

  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream")) {
    const data = (await res.json()) as { error?: string };
    if (data.error) {
      throw new Error(data.error);
    }
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        const data = JSON.parse(line.slice(6)) as Record<string, unknown>;
        if (data.type === "chat:error") {
          throw new Error(String(data.error ?? "Unknown chat bootstrap error"));
        }
      } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }
    }
  }
}

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

      if (!userText) {
        return;
      }

      const includeCardContext = Boolean(cardContextJson) &&
        !bootstrappedSessionsRef.current.has(sessionKey);
      const body = buildChatRequestBody({
        sessionKey,
        userText,
        cardContextJson,
        includeCardContext,
      });

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
        return;
      }

      // SSE stream: read data: {...} lines
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let accumulatedText = "";
      const toolSteps: ProactiveToolStep[] = [];
      const toolStepIndex = new Map<string, number>();

      const snapshot = () => buildContentSnapshot(toolSteps, accumulatedText);

      while (true) {
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
              accumulatedText += (data.delta as string) ?? "";
              yield { content: snapshot() };
            } else if (type === "chat:reply") {
              accumulatedText = (data.content as string) ?? "";
              yield { content: snapshot() };
            } else if (type === "chat:tool:start") {
              const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : "";
              const name = typeof data.name === "string" ? data.name : "";
              if (!toolCallId || !name) continue;
              if (!toolStepIndex.has(toolCallId)) {
                toolStepIndex.set(toolCallId, toolSteps.length);
                toolSteps.push({
                  toolCallId,
                  toolName: name,
                  meta: typeof data.meta === "string" ? data.meta : undefined,
                  argsPreview: typeof data.argsPreview === "string" ? data.argsPreview : undefined,
                  pinCommand: typeof data.pinCommand === "string" ? data.pinCommand : undefined,
                  status: "running",
                });
                yield { content: snapshot() };
              }
            } else if (type === "chat:tool:result") {
              const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : "";
              const idx = toolCallId ? toolStepIndex.get(toolCallId) : undefined;
              if (idx === undefined) continue;
              const step = toolSteps[idx];
              step.status = data.isError ? "error" : "ok";
              if (typeof data.meta === "string" && !step.meta) {
                step.meta = data.meta;
              }
              yield { content: snapshot() };
            } else if (type === "chat:tool:update") {
              // Keep "running" state; no-op snapshot avoids unnecessary churn.
              continue;
            } else if (type === "chat:error") {
              throw new Error(data.error as string);
            }
            // chat:thinking and chat:done are handled implicitly.
          } catch (e) {
            if (e instanceof SyntaxError) continue;
            throw e;
          }
        }
      }

      // Ensure we yield at least once if we got content (text or tool steps).
      if (accumulatedText || toolSteps.length > 0) {
        yield { content: snapshot() };
      }

      if (includeCardContext) {
        bootstrappedSessionsRef.current.add(sessionKey);
      }
    },
  };
}

/**
 * Fetch existing chat history from the backend and convert to ThreadMessageLike[].
 */
async function fetchHistory(sessionKey: string): Promise<ThreadMessageLike[]> {
  try {
    const histRes = await proxyFetch(
      `/chat-stream/history?sessionKey=${encodeURIComponent(sessionKey)}`,
    );
    const histData = await histRes.json();

    if (!histData.ok || !Array.isArray(histData.messages)) return [];

    return histData.messages.map(
      (m: {
        id: string;
        role: string;
        content: string;
        createdAt?: number;
      }) => ({
        role: m.role as "user" | "assistant",
        content: [{ type: "text" as const, text: m.content }],
        ...(typeof m.createdAt === "number" && Number.isFinite(m.createdAt)
          ? { createdAt: new Date(m.createdAt) }
          : {}),
      }),
    );
  } catch {
    return [];
  }
}

export function useProactiveChatRuntime(options: UseProactiveChatRuntimeOptions) {
  const [initialMessages, setInitialMessages] = useState<
    ThreadMessageLike[] | undefined
  >(undefined);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const bootstrappedSessionsRef = useRef<Set<string>>(new Set());
  const bootstrapPromisesRef = useRef<Map<string, Promise<void>>>(new Map());
  const cardContextJson = useMemo(
    () => (options.cardContext ? JSON.stringify(options.cardContext) : undefined),
    [options.cardContext],
  );

  useEffect(() => {
    let cancelled = false;
    setHistoryLoaded(false);
    setInitialMessages(undefined);

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

        if (
          cardContextJson &&
          shouldBootstrapCardChat({
            hasExistingHistory,
            hasCardContext: true,
            alreadyBootstrapped: bootstrappedSessionsRef.current.has(options.sessionKey),
          })
        ) {
          let bootstrapPromise = bootstrapPromisesRef.current.get(options.sessionKey);
          if (!bootstrapPromise) {
            bootstrapPromise = bootstrapCardChatSession(options.sessionKey, cardContextJson);
            bootstrapPromisesRef.current.set(options.sessionKey, bootstrapPromise);
          }
          try {
            await bootstrapPromise;
            bootstrappedSessionsRef.current.add(options.sessionKey);
          } catch (error) {
            console.warn("[Chat] Card bootstrap failed:", error);
          } finally {
            if (bootstrapPromisesRef.current.get(options.sessionKey) === bootstrapPromise) {
              bootstrapPromisesRef.current.delete(options.sessionKey);
            }
          }
        }

        const msgs = await fetchHistory(options.sessionKey);
        if (cancelled) return;
        if (msgs.length > 0) {
          bootstrappedSessionsRef.current.add(options.sessionKey);
        }
        setInitialMessages(msgs.length > 0 ? msgs : undefined);
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

  return { runtime, historyLoaded };
}
