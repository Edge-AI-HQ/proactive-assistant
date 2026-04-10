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

const CHAR_INTERVAL_MS = 18;
const CHUNK_SIZE = 2;

export default function CardChat({ card, score, onBack }: CardChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);
  const typingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
    return () => {
      if (typingTimerRef.current) clearInterval(typingTimerRef.current);
    };
  }, []);

  const typeOutReply = useCallback((fullContent: string, msgId: string) => {
    if (typingTimerRef.current) {
      clearInterval(typingTimerRef.current);
      typingTimerRef.current = null;
    }

    let charIndex = 0;

    setMessages((prev) => [
      ...prev,
      { id: msgId, role: "assistant", content: "", typing: true },
    ]);

    typingTimerRef.current = setInterval(() => {
      charIndex = Math.min(charIndex + CHUNK_SIZE, fullContent.length);
      const partial = fullContent.slice(0, charIndex);
      const done = charIndex >= fullContent.length;

      setMessages((prev) =>
        prev.map((m) =>
          m.id === msgId
            ? { ...m, content: partial, typing: !done }
            : m
        )
      );

      if (done) {
        if (typingTimerRef.current) {
          clearInterval(typingTimerRef.current);
          typingTimerRef.current = null;
        }
        setLoading(false);
      }
    }, CHAR_INTERVAL_MS);
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
      setMessages([{ id: "ai-waiting", role: "assistant", content: "", typing: false }]);

      try {
        const res = await apiPost("/api/chat", { sessionKey, cardContext });
        const data = await res.json();
        if (data.ok) {
          setMessages([]);
          typeOutReply(data.reply, "ai-0");
        } else {
          setMessages([]);
          setError(data.error ?? "Failed to start conversation");
          setLoading(false);
        }
      } catch (err) {
        setMessages([]);
        setError(err instanceof Error ? err.message : "Network error");
        setLoading(false);
      }
    })();
  }, [card, score, sessionKey, typeOutReply]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: ChatMessage = { id: `user-${Date.now()}`, role: "user", content: text };
    setMessages((prev) => [...prev.filter((m) => !m.typing || m.content), userMsg]);
    setInput("");
    setLoading(true);
    setError(null);

    const waitingId = `ai-waiting-${Date.now()}`;
    setMessages((prev) => [...prev, { id: waitingId, role: "assistant", content: "", typing: false }]);

    try {
      const res = await apiPost("/api/chat", { sessionKey, message: text });
      const data = await res.json();
      if (data.ok) {
        setMessages((prev) => prev.filter((m) => m.id !== waitingId));
        typeOutReply(data.reply, `ai-${Date.now()}`);
      } else {
        setMessages((prev) => prev.filter((m) => m.id !== waitingId));
        setError(data.error ?? "Failed to get response");
        setLoading(false);
      }
    } catch (err) {
      setMessages((prev) => prev.filter((m) => m.id !== waitingId));
      setError(err instanceof Error ? err.message : "Network error");
      setLoading(false);
    }
  }, [input, loading, sessionKey, typeOutReply]);

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
            const isWaiting = msg.role === "assistant" && !msg.content && !msg.typing;
            const isTyping = msg.typing && msg.content;

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
                    msg.content
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
