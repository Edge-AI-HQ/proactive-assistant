import { useState } from "react";
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

  useState(() => {
    const timers: NodeJS.Timeout[] = [];
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
            if (i === steps.length - 1) {
              setTimeout(() => setOutputVisible(true), 600);
            }
          }, (i - 1) * 1500)
        );
      }
    });
    return () => timers.forEach(clearTimeout);
  });

  const completedCount = steps.filter((s) => s.status === "done").length;

  return (
    <div className="flex flex-col h-full px-4 pt-14 pb-2 relative">
      {/* Dark overlay for text readability */}
      <div
        className="absolute inset-0 pointer-events-none z-0"
        style={{
          background: "linear-gradient(to bottom, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.4) 30%, rgba(0,0,0,0.15) 60%, transparent 100%)",
        }}
      />
      <button
        onClick={onBack}
        className="text-sm text-primary font-medium mb-4 self-start flex items-center gap-1 relative z-10 drop-shadow-sm"
      >
        <ArrowLeft size={14} /> Back
      </button>

      <h2 className="text-display text-lg text-white mb-1 relative z-10 font-bold" style={{ textShadow: "0 2px 8px rgba(0,0,0,0.6)" }}>Executing</h2>
      <p className="text-sm text-white/85 mb-6 line-clamp-2 relative z-10 font-medium" style={{ textShadow: "0 1px 6px rgba(0,0,0,0.5)" }}>
        {intentTitle}
      </p>

      <div className="space-y-3 flex-1 overflow-y-auto relative z-10">
        {steps.map((step, i) => (
          <motion.div
            key={step.label}
            initial={{ opacity: 0, x: -16 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: i * 0.12 }}
            className="glass-card-strong p-4 flex items-start gap-3"
          >
            <span className="mt-0.5">
              {step.status === "done" ? (
                <CheckCircle2 size={16} className="text-emerald-500" />
              ) : step.status === "running" ? (
                <Loader2 size={16} className="text-primary animate-spin" />
              ) : (
                <Circle size={16} className="text-foreground/30" />
              )}
            </span>
            <span
              className={`text-sm font-medium ${
                step.status === "done"
                  ? "text-foreground/80"
                  : step.status === "running"
                  ? "text-foreground font-semibold"
                  : "text-foreground/50"
              }`}
            >
              {step.label}
            </span>
          </motion.div>
        ))}

        <div className="glass-card-strong p-3 text-center">
          <span className="text-xs text-foreground/70 font-medium">
            {completedCount} of {steps.length} operations completed
          </span>
        </div>

        {outputVisible && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="glass-card-strong p-5 glow-primary"
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

      <div className="glass-card-strong mt-3 px-4 py-3 flex items-center gap-2 relative z-10">
        <input
          type="text"
          placeholder="Type message (optional)"
          className="flex-1 bg-transparent text-sm text-foreground placeholder:text-foreground/40 outline-none"
        />
        <button className="text-primary">
          <Send size={16} />
        </button>
      </div>
    </div>
  );
}
