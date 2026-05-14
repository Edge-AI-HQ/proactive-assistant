/**
 * @deprecated 2026-05-14 — Constellation execution surface is `CardChat` →
 * `MainChatView` (real SSE-driven). This file was a setTimeout-driven mock
 * never wired in the v3 backend. Kept only for reference.
 */

import { useState, useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { CheckCircle2, Loader2, Circle, ArrowLeft, Send } from "lucide-react";

interface Step {
  label: string;
  status: "done" | "running" | "pending";
}

const MOCK_STEPS: Step[] = [
  { label: "Search Anthropic Mythos model details", status: "done" },
  { label: "Cross-reference with PIN AI strategy docs", status: "done" },
  { label: "Compile briefing on Mythos + IPO implications", status: "running" },
  { label: "Save to Notion workspace", status: "pending" },
  { label: "Flag for Monday's team meeting", status: "pending" },
];

interface ExecutionViewProps {
  intentTitle: string;
  onBack: () => void;
}

export default function ExecutionView({ intentTitle, onBack }: ExecutionViewProps) {
  const [steps, setSteps] = useState(MOCK_STEPS);
  const [outputVisible, setOutputVisible] = useState(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    steps.forEach((_, i) => {
      if (i >= 2) {
        timers.push(
          setTimeout(() => {
            setSteps((prev) =>
              prev.map((s, j) => ({
                ...s,
                status: j <= i ? "done" : j === i + 1 ? "running" : "pending",
              }))
            );
            if (i === MOCK_STEPS.length - 1) {
              timers.push(setTimeout(() => setOutputVisible(true), 600));
            }
          }, (i - 1) * 1500)
        );
      }
    });
    timersRef.current = timers;
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const completedCount = steps.filter((s) => s.status === "done").length;

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
      <div className="flex flex-col h-full px-4 pt-3 pb-2">
        <button
          onClick={onBack}
          className="text-sm text-primary font-medium mb-4 self-start flex items-center gap-1"
        >
          <ArrowLeft size={14} /> Back
        </button>

        <h2 className="text-display text-lg text-foreground mb-1">Executing</h2>
        <p className="text-sm text-muted-foreground mb-6 line-clamp-2">
          {intentTitle}
        </p>

        <div className="space-y-3 flex-1 overflow-y-auto">
          {steps.map((step, i) => (
            <motion.div
              key={step.label}
              initial={{ opacity: 0, x: -16 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.12 }}
              className="glass-card p-4 flex items-start gap-3"
            >
              <span className="mt-0.5">
                {step.status === "done" ? (
                  <CheckCircle2 size={16} className="text-emerald-500" />
                ) : step.status === "running" ? (
                  <Loader2 size={16} className="text-primary animate-spin" />
                ) : (
                  <Circle size={16} className="text-foreground/20" />
                )}
              </span>
              <span
                className={`text-sm ${
                  step.status === "done"
                    ? "text-foreground/70"
                    : step.status === "running"
                    ? "text-foreground font-medium"
                    : "text-foreground/40"
                }`}
              >
                {step.label}
              </span>
            </motion.div>
          ))}

          <div className="glass-card p-3 text-center">
            <span className="text-xs text-muted-foreground">
              {completedCount} of {steps.length} operations completed
            </span>
          </div>

          {outputVisible && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="glass-card-strong p-5"
            >
              <p className="text-[10px] text-primary font-bold uppercase tracking-wider mb-2">
                AI Output
              </p>
              <p className="text-sm text-foreground leading-relaxed">
                Compiled a briefing on Mythos + IPO implications for PIN AI, saved
                to Notion, and flagged for Monday's team meeting.
              </p>
            </motion.div>
          )}
        </div>

        <div className="glass-card mt-3 px-4 py-3 flex items-center gap-2">
          <input
            type="text"
            placeholder="Type message (optional)"
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-foreground/30 outline-none"
          />
          <button className="text-primary">
            <Send size={16} />
          </button>
        </div>
      </div>
    </motion.div>
  );
}
