import { useState, useRef, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import { ArrowLeft, Send, Loader2 } from "lucide-react";
import type { IntentCard, EvaluationScore } from "@/hooks/use-pipeline";

import { apiFetch, apiPost } from "@/lib/api";

interface CardChatProps {
  card: IntentCard;
  score?: EvaluationScore | null;
  onBack: () => void;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  typing?: boolean;
}

function stableSessionKey(cardId: string): string {
  return `agent:main:proactive-ai:chat:card:${cardId}`;
}

interface SseEvent {
  type: "start" | "delta" | "done" | "error";
  content?: string;
  sessionKey?: string;
  message?: string;
}

async function readSseStream(
  response: Response,
  onEvent: (event: SseEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const parsed = JSON.parse(line.slice(6)) as SseEvent;
          onEvent(parsed);
        } catch { /* malformed JSON line, skip */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export default function CardChat({ card, score, onBack }: CardChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const sessionKey = stableSessionKey(card.id);

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    });
  }, []);

  useEffect(() => { scrollToBottom(); }, [messages, scrollToBottom]);

  useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);

  const streamChat = useCallback(async (
    body: Record<string, unknown>,
    assistantMsgId: string,
  ) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setMessages((prev) => [
      ...prev.filter((m) => m.id !== assistantMsgId),
      { id: assistantMsgId, role: "assistant", content: "", typing: true },
    ]);

    try {
      const res = await apiFetch("/api/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }

      await readSseStream(res, (event) => {
        if (controller.signal.aborted) return;

        if (event.type === "delta" && event.content) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId
                ? { ...m, content: event.content!, typing: true }
                : m
            )
          );
        } else if (event.type === "done") {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId
                ? { ...m, content: event.content ?? m.content, typing: false }
                : m
            )
          );
          setLoading(false);
        } else if (event.type === "error") {
          setMessages((prev) => prev.filter((m) => m.id !== assistantMsgId));
          setError(event.message ?? "Agent error");
          setLoading(false);
        }
      }, controller.signal);

      if (!controller.signal.aborted) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId && m.typing
              ? { ...m, typing: false }
              : m
          )
        );
        setLoading(false);
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      setMessages((prev) => prev.filter((m) => m.id !== assistantMsgId));
      setError(err instanceof Error ? err.message : "Network error");
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    (async () => {
      setRestoring(true);
      try {
        const res = await apiFetch(`/api/chat/history?sessionKey=${encodeURIComponent(sessionKey)}`);
        const data = await res.json();
        if (data.ok && Array.isArray(data.messages) && data.messages.length > 0) {
          setMessages(data.messages);
          setRestoring(false);
          return;
        }
      } catch { /* no history */ }
      setRestoring(false);

      const cardContext = JSON.stringify({
        title: card.title,
        goalBasket: card.goalBasket,
        whyNow: card.whyNow,
        summary: card.summary,
        primaryAction: card.primaryAction,
        secondaryActions: card.secondaryActions,
        confidence: card.confidence,
        urgency: card.urgency,
        importance: card.importance,
        sources: card.sources,
        ...(score && {
          evaluatorScore: score.overall,
          evaluatorFeedback: score.feedback,
          evaluatorDimensions: score.dimensions,
        }),
      }, null, 2);

      setLoading(true);
      setError(null);
      streamChat({ sessionKey, cardContext }, "ai-0");
    })();
  }, [card, score, sessionKey, streamChat]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: ChatMessage = { id: `user-${Date.now()}`, role: "user", content: text };
    setMessages((prev) => [...prev.filter((m) => !m.typing || m.content), userMsg]);
    setInput("");
    setLoading(true);
    setError(null);

    streamChat({ sessionKey, message: text }, `ai-${Date.now()}`);
  }, [input, loading, sessionKey, streamChat]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <motion.div
      initial={{ y: "100%" }}
      animate={{ y: 0 }}
      exit={{ y: "100%" }}
      transition={{ type: "spring", damping: 30, stiffness: 300 }}
      className="absolute inset-0 z-50 flex flex-col"
      style={{
        backdropFilter: "blur(20px) saturate(1.3)",
        WebkitBackdropFilter: "blur(20px) saturate(1.3)",
      }}
    >
      {/* Header */}
      <div className="shrink-0 px-4 pt-14 pb-3 border-b border-foreground/[0.08]">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="p-2 -ml-1 rounded-xl hover:bg-foreground/10 transition-colors"
          >
            <ArrowLeft size={20} strokeWidth={1.8} className="text-foreground/70" />
          </button>
          <div className="flex-1 min-w-0">
            <h2 className="text-display text-[15px] text-foreground truncate">
              {card.title}
            </h2>
            <p className="text-[11px] text-foreground/40">
              {messages.filter((m) => m.content && !m.typing).length > 0
                ? `${messages.filter((m) => m.content && !m.typing).length} messages`
                : "Chat with AI about this card"}
            </p>
          </div>
        </div>
      </div>

      {/* Card summary pill */}
      <div className="px-4 pt-3 pb-1">
        <div className="glass-card px-3 py-2 text-[12px] text-foreground/60 leading-relaxed">
          <span className="font-semibold text-foreground/80">{card.goalBasket.toUpperCase()}</span>
          {" — "}
          {card.whyNow.length > 120 ? card.whyNow.slice(0, 120) + "..." : card.whyNow}
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3">
        <div className="flex flex-col gap-3">
          {restoring && (
            <div className="flex justify-center py-8">
              <div className="flex items-center gap-2">
                <Loader2 size={14} className="animate-spin text-foreground/40" />
                <span className="text-[13px] text-foreground/40">Loading conversation...</span>
              </div>
            </div>
          )}

          {messages.map((msg) => {
            const isStreaming = msg.role === "assistant" && msg.typing;
            const isWaiting = msg.role === "assistant" && !msg.content && msg.typing;

            return (
              <div
                key={msg.id}
                className={"flex " + (msg.role === "user" ? "justify-end" : "justify-start")}
              >
                <div
                  className="max-w-[82%] px-3.5 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap rounded-2xl border border-foreground/[0.06]"
                  style={msg.role === "user"
                    ? { background: "rgba(59,130,246,0.10)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)" }
                    : { background: "rgba(255,255,255,0.45)", backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)" }
                  }
                >
                  {isWaiting ? (
                    <span className="flex items-center gap-2">
                      <Loader2 size={14} className="animate-spin text-foreground/40" />
                      <span className="text-[13px] text-foreground/40">Thinking...</span>
                    </span>
                  ) : (
                    <>
                      {msg.content}
                      {isStreaming && <span className="inline-block w-[2px] h-[14px] bg-foreground/50 ml-0.5 animate-pulse align-middle" />}
                    </>
                  )}
                </div>
              </div>
            );
          })}

          {error && (
            <div className="glass-card px-4 py-3 rounded-2xl border border-destructive/20">
              <p className="text-[13px] text-destructive/80">{error}</p>
            </div>
          )}
        </div>
      </div>

      {/* Input bar */}
      <div className="shrink-0 px-4 pb-6 pt-2.5">
        <div
          className="flex items-center gap-3 px-4 py-3 rounded-2xl border border-foreground/10"
          style={{ background: "rgba(255,255,255,0.6)", backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)" }}
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={loading ? "Waiting for response..." : "Type a message..."}
            disabled={loading || restoring}
            className="flex-1 bg-transparent text-[15px] text-foreground placeholder:text-foreground/35 outline-none disabled:opacity-50"
          />
          <button
            onClick={sendMessage}
            disabled={!input.trim() || loading || restoring}
            className="w-8 h-8 rounded-full bg-foreground flex items-center justify-center text-background hover:bg-foreground/80 transition-colors disabled:opacity-30"
          >
            <Send size={15} strokeWidth={2} />
          </button>
        </div>
      </div>
    </motion.div>
  );
}
