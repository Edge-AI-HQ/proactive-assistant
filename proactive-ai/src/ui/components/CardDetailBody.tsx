import { useState } from "react";
import { motion } from "framer-motion";
import {
  Zap, ArrowRight, Pencil, MessageCircle, CheckCircle2, X,
  Clock, Send,
} from "lucide-react";
import type { IntentCard, EvaluationScore } from "@/hooks/use-pipeline";
import { basketMeta } from "@/lib/basket-meta";

interface CardDetailBodyProps {
  card: IntentCard;
  score?: EvaluationScore | null;
  onChat: () => void;
  onDismiss: () => void;
  onConfirm: () => void;
  onSnooze: () => void;
  onModify: () => void;
  onTextFeedback: (text: string) => void;
  enableSwipe?: boolean;
}

export default function CardDetailBody({
  card,
  score,
  onChat,
  onDismiss,
  onConfirm,
  onSnooze,
  onModify,
  onTextFeedback,
  enableSwipe = false,
}: CardDetailBodyProps) {
  const [feedbackText, setFeedbackText] = useState("");
  const meta = basketMeta(card.goalBasket);
  const Icon = meta.icon;

  const scores: { label: string; value: number; highlight?: boolean }[] = [
    { label: "Confidence", value: Math.round(card.confidence * 100) },
    { label: "Importance", value: Math.round(card.importance * 100) },
    { label: "Urgency", value: Math.round(card.urgency * 100) },
  ];
  if (score) {
    scores.push({ label: "Overall", value: Math.round(score.overall * 10), highlight: true });
  }

  const inner = (
    <>
      {enableSwipe && (
        <div className="flex justify-between mb-3 px-2">
          <span className="text-[10px] text-foreground/25">← swipe to dismiss</span>
          <span className="text-[10px] text-foreground/25">swipe to chat →</span>
        </div>
      )}

      {/* Category */}
      <div className="flex items-center gap-1.5 mb-2">
        <Icon size={14} strokeWidth={1.5} className="text-foreground/50" />
        <span className="text-xs font-semibold tracking-wide text-foreground/50 uppercase">{meta.label}</span>
        {card.urgency >= 0.85 && (
          <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-foreground/10 text-foreground/50">Urgent</span>
        )}
      </div>

      {/* Title */}
      <h3 className="text-display text-[18px] leading-snug text-foreground mb-2.5 font-semibold">{card.title}</h3>

      {/* Why Now */}
      {card.whyNow && (
        <div className="rounded-xl bg-green-50/60 border border-green-200/40 p-3 mb-4">
          <div className="text-xs font-semibold text-green-700/80 mb-1">Why Now</div>
          <p className="text-[13px] text-foreground/80 leading-relaxed">{card.whyNow}</p>
        </div>
      )}

      {/* Summary */}
      {card.summary && (
        <div className="rounded-xl bg-foreground/[0.03] border border-foreground/10 p-3 mb-4">
          <div className="text-xs font-semibold text-foreground/50 mb-1">Summary</div>
          <p className="text-[13px] text-foreground/70 leading-relaxed">{card.summary}</p>
        </div>
      )}

      {/* Scores */}
      <div className={`grid gap-2 mb-4 ${scores.length === 4 ? "grid-cols-4" : "grid-cols-3"}`}>
        {scores.map((s) => (
          <div key={s.label} className="rounded-xl bg-foreground/5 py-2.5 text-center">
            <div className={`text-lg font-bold ${s.highlight ? "text-purple-600" : "text-foreground/80"}`}>{s.value}</div>
            <div className="text-[12px] text-foreground/50 mt-0.5 font-medium">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Will execute on confirm */}
      {card.primaryAction && (
        <div className="rounded-xl p-4 mb-4 border border-pink-200/40" style={{ background: "linear-gradient(135deg, rgba(225,92,230,0.08) 0%, rgba(225,92,230,0.04) 100%)" }}>
          <div className="text-[13px] font-bold mb-1.5 flex items-center gap-1.5">
            <Zap size={13} strokeWidth={2} color="hsl(292,78%,63%)" />
            <span className="bg-gradient-to-r from-[hsl(292,78%,63%)] to-[hsl(330,80%,65%)] bg-clip-text text-transparent">Will execute on confirm</span>
          </div>
          <p className="text-[15px] text-foreground font-medium leading-relaxed">{card.primaryAction.label}</p>
        </div>
      )}

      {/* Quick actions */}
      <div className="mb-4">
        <div className="text-xs font-semibold text-foreground/50 uppercase tracking-wide mb-2">Quick Actions</div>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 rounded-xl bg-foreground/4 px-3 py-2.5">
            <Pencil size={13} strokeWidth={1.5} className="text-foreground/40 shrink-0" />
            <span className="text-[13px] text-foreground/65 flex-1">Adjust this card, then chat about it</span>
            <button onClick={onModify} className="text-[12px] font-medium text-foreground/45 bg-foreground/[0.06] hover:bg-foreground/[0.1] px-2.5 py-1 rounded-full whitespace-nowrap transition-colors">
              modify
            </button>
          </div>
          <div className="flex items-center gap-2 rounded-xl bg-foreground/4 px-3 py-2.5">
            <Clock size={13} strokeWidth={1.5} className="text-foreground/40 shrink-0" />
            <span className="text-[13px] text-foreground/65 flex-1">Not now, remind me later</span>
            <button onClick={onSnooze} className="text-[12px] font-medium text-foreground/45 bg-foreground/[0.06] hover:bg-foreground/[0.1] px-2.5 py-1 rounded-full whitespace-nowrap transition-colors">
              snooze
            </button>
          </div>
          <div className="flex items-center gap-2 rounded-xl bg-foreground/4 px-3 py-2.5">
            <X size={13} strokeWidth={1.5} className="text-foreground/40 shrink-0" />
            <span className="text-[13px] text-foreground/65 flex-1">Not relevant, don't show again</span>
            <button onClick={onDismiss} className="text-[12px] font-medium text-foreground/45 bg-foreground/[0.06] hover:bg-foreground/[0.1] px-2.5 py-1 rounded-full whitespace-nowrap transition-colors">
              dismiss
            </button>
          </div>
        </div>
      </div>

      {/* Data Sources */}
      {card.sources.length > 0 && (
        <div className="mb-4 rounded-xl bg-foreground/[0.04] border border-foreground/[0.06] p-3.5">
          <div className="text-xs font-semibold text-foreground/60 uppercase tracking-wide mb-2">Data Sources</div>
          {card.sources.map((ds, i) => (
            <div key={i} className="flex items-start gap-2 mb-1.5 last:mb-0">
              <span className="w-1.5 h-1.5 rounded-full bg-foreground/30 mt-1.5 shrink-0" />
              <span className="text-[13px] text-foreground/60 leading-relaxed">{ds}</span>
            </div>
          ))}
        </div>
      )}

      {/* Evaluator feedback */}
      {score?.feedback && (
        <div className="mb-4">
          <div className="text-xs font-semibold text-foreground/50 uppercase tracking-wide mb-2">Evaluator Feedback</div>
          <p className="text-[13px] text-foreground/60 leading-relaxed">{score.feedback}</p>
        </div>
      )}

      {/* Primary actions */}
      <div className="flex items-center gap-2 mb-3">
        <button
          onClick={onChat}
          className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl bg-foreground/10 hover:bg-foreground/15 transition-colors text-sm font-medium text-foreground/70"
        >
          <MessageCircle size={13} strokeWidth={2} />
          Chat
        </button>
        <button
          onClick={onConfirm}
          className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl bg-foreground text-background text-sm font-semibold hover:bg-foreground/85 transition-colors"
        >
          <CheckCircle2 size={13} strokeWidth={2} />
          Confirm
        </button>
      </div>

      {/* Text feedback */}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={feedbackText}
          onChange={(e) => setFeedbackText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && feedbackText.trim()) {
              onTextFeedback(feedbackText.trim());
              setFeedbackText("");
            }
          }}
          placeholder="Tell AI what you prefer..."
          className="flex-1 text-xs bg-foreground/[0.03] border border-foreground/[0.06] rounded-lg px-3 py-2 text-foreground/70 placeholder:text-foreground/25 focus:outline-none focus:border-foreground/15"
        />
        <button
          onClick={() => {
            if (feedbackText.trim()) {
              onTextFeedback(feedbackText.trim());
              setFeedbackText("");
            }
          }}
          disabled={!feedbackText.trim()}
          className="p-2 rounded-lg bg-foreground/[0.03] hover:bg-foreground/[0.06] transition-colors text-foreground/40 disabled:opacity-30"
        >
          <Send size={12} strokeWidth={1.5} />
        </button>
      </div>
    </>
  );

  if (enableSwipe) {
    return (
      <motion.div
        drag="x"
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={0.3}
        onDragEnd={(_e, info) => {
          if (info.offset.x < -100) onDismiss();
          if (info.offset.x > 100) onChat();
        }}
        className="px-5 pb-6 pt-2 overflow-y-auto max-h-[75vh]"
      >
        {inner}
      </motion.div>
    );
  }

  return (
    <div className="px-5 pb-6 pt-2 overflow-y-auto max-h-[75vh]">
      {inner}
    </div>
  );
}
