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
}

function stableSessionKey(cardId: string): string {
  return `agent:main:proactive-ai:chat:card:${cardId}`;
}

export default function CardChat({ card, score, onBack }: CardChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);

  const sessionKey = stableSessionKey(card.id);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  useEffect(() => { scrollToBottom(); }, [messages, scrollToBottom]);

  // On mount: try to restore history, then initialize if needed
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
      } catch { /* no history, proceed to init */ }
      setRestoring(false);

      // First turn: send card context so AI responds first
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

      try {
        const res = await apiPost("/api/chat", { sessionKey, cardContext });
        const data = await res.json();
        if (data.ok) {
          setMessages([{ id: "ai-0", role: "assistant", content: data.reply }]);
        } else {
          setError(data.error ?? "Failed to start conversation");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Network error");
      } finally {
        setLoading(false);
      }
    })();
  }, [card, score, sessionKey]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: ChatMessage = { id: `user-${Date.now()}`, role: "user", content: text };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);
    setError(null);

    try {
      const res = await apiPost("/api/chat", { sessionKey, message: text });
      const data = await res.json();
      if (data.ok) {
        setMessages((prev) => [
          ...prev,
          { id: `ai-${Date.now()}`, role: "assistant", content: data.reply },
        ]);
      } else {
        setError(data.error ?? "Failed to get response");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, [input, loading, sessionKey]);

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
        background: "hsla(220, 30%, 96%, 0.95)",
        backdropFilter: "blur(60px) saturate(1.4)",
        WebkitBackdropFilter: "blur(60px) saturate(1.4)",
      }}
    >
      {/* Header */}
      <div
        className="shrink-0 px-4 pt-[calc(0.75rem+env(safe-area-inset-top,0px))] pb-3"
        style={{
          background: "hsla(0, 0%, 100%, 0.5)",
          borderBottom: "1px solid hsla(0, 0%, 100%, 0.4)",
          backdropFilter: "blur(40px)",
          WebkitBackdropFilter: "blur(40px)",
        }}
      >
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
              {messages.length > 0 ? `${messages.length} messages` : "Chat with AI about this card"}
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

          {messages.map((msg) => (
            <div
              key={msg.id}
              className={"flex " + (msg.role === "user" ? "justify-end" : "justify-start")}
            >
              <div
                className={
                  "max-w-[85%] px-4 py-3 text-[14px] leading-relaxed whitespace-pre-wrap " +
                  (msg.role === "user"
                    ? "bg-foreground text-background rounded-2xl rounded-br-md"
                    : "glass-card-strong rounded-2xl rounded-bl-md text-foreground/80")
                }
              >
                {msg.content}
              </div>
            </div>
          ))}

          {loading && (
            <div className="flex justify-start">
              <div className="glass-card px-4 py-3 rounded-2xl rounded-bl-md flex items-center gap-2">
                <Loader2 size={14} className="animate-spin text-foreground/40" />
                <span className="text-[13px] text-foreground/40">Thinking...</span>
              </div>
            </div>
          )}

          {error && (
            <div className="glass-card px-4 py-3 rounded-2xl border border-destructive/20">
              <p className="text-[13px] text-destructive/80">{error}</p>
            </div>
          )}
        </div>
      </div>

      {/* Input bar */}
      <div
        className="shrink-0 px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))] pt-2"
        style={{
          background: "hsla(0, 0%, 100%, 0.35)",
          borderTop: "1px solid hsla(0, 0%, 100%, 0.3)",
        }}
      >
        <div className="glass-card-strong flex items-center gap-2 px-4 py-2 rounded-2xl">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={loading ? "Waiting for response..." : "Type a message..."}
            disabled={loading || restoring}
            className="flex-1 bg-transparent text-[14px] text-foreground placeholder:text-foreground/35 outline-none disabled:opacity-50"
          />
          <button
            onClick={sendMessage}
            disabled={!input.trim() || loading || restoring}
            className="p-2 rounded-xl transition-colors disabled:opacity-30 hover:bg-foreground/10"
          >
            <Send size={18} strokeWidth={1.8} className="text-foreground/60" />
          </button>
        </div>
      </div>
    </motion.div>
  );
}
