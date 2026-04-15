/**
 * Custom ChatModelAdapter for the proactive-ai backend.
 *
 * POST /chat-stream/send returns an SSE stream:
 *   data: { type: "chat:thinking", ... }
 *   data: { type: "chat:reply", content: "...", ... }
 *   data: { type: "chat:error", error: "...", ... }
 *
 * The adapter yields accumulated content snapshots as required by assistant-ui.
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
              // Streaming token delta — append and yield snapshot
              accumulatedText += data.delta as string;
              yield {
                content: [{ type: "text" as const, text: accumulatedText }],
              };
            } else if (type === "chat:reply") {
              // Non-streaming fallback — full reply in one shot
              accumulatedText = data.content as string;
              yield {
                content: [{ type: "text" as const, text: accumulatedText }],
              };
            } else if (type === "chat:error") {
              throw new Error(data.error as string);
            }
            // chat:thinking and chat:done are handled implicitly
            // (thinking = no yield yet, done = stream ends naturally)
          } catch (e) {
            if (e instanceof SyntaxError) continue;
            throw e;
          }
        }
      }

      // Ensure we yield at least once if we got content
      if (accumulatedText) {
        yield {
          content: [{ type: "text" as const, text: accumulatedText }],
        };
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
      (m: { id: string; role: string; content: string }) => ({
        role: m.role as "user" | "assistant",
        content: [{ type: "text" as const, text: m.content }],
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
