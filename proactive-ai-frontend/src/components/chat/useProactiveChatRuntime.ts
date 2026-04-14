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
import { useState, useEffect } from "react";
import {
  useLocalRuntime,
  type ChatModelAdapter,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { proxyFetch, proxyPost } from "@/lib/api";

interface AdapterOptions {
  sessionKey: string;
  cardContext?: Record<string, unknown>;
}

function createAdapter({ sessionKey, cardContext }: AdapterOptions): ChatModelAdapter {
  let isFirstRun = true;

  return {
    async *run({ messages, abortSignal }) {
      // Extract the latest user message text from the thread
      const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
      const userText = lastUserMsg?.content
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("\n");

      // Build request body
      const body: Record<string, unknown> = { sessionKey };

      if (isFirstRun && cardContext && !userText) {
        // First-turn card context: no user message, just card context
        body.cardContext = JSON.stringify(cardContext);
      } else if (userText) {
        body.message = userText;
        // On first user message with card context, include it
        if (isFirstRun && cardContext) {
          body.cardContext = JSON.stringify(cardContext);
        }
      } else {
        return; // Nothing to send
      }

      isFirstRun = false;

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
    },
  };
}

/**
 * Fetch existing chat history from the backend and convert to ThreadMessageLike[].
 */
async function fetchHistory(sessionKey: string): Promise<ThreadMessageLike[]> {
  try {
    const initRes = await proxyPost("/chat-stream/init", { sessionKey });
    const initData = await initRes.json();

    if (!initData.ok || !initData.existing) return [];

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

export function useProactiveChatRuntime(options: AdapterOptions) {
  const [initialMessages, setInitialMessages] = useState<
    ThreadMessageLike[] | undefined
  >(undefined);
  const [historyLoaded, setHistoryLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchHistory(options.sessionKey).then((msgs) => {
      if (cancelled) return;
      setInitialMessages(msgs.length > 0 ? msgs : undefined);
      setHistoryLoaded(true);
    });
    return () => { cancelled = true; };
  }, [options.sessionKey]);

  const adapter = createAdapter(options);
  const runtime = useLocalRuntime(adapter, { initialMessages });

  return { runtime, historyLoaded };
}
