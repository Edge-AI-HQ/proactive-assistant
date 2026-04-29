/**
 * Tiny "generating cards" indicator.
 *
 * Renders nothing when idle. When the backend is generating (manual run OR
 * auto-loop tick), shows a single dot + label. Source of truth is
 * useGenerationStatus, which polls /runs/active.
 */
import { motion } from "framer-motion";
import { useGenerationStatus } from "@/hooks/useGenerationStatus";
import { cn } from "@/lib/utils";

export function GenerationIndicator({ className }: { className?: string }) {
  const { isGenerating, run } = useGenerationStatus();
  if (!isGenerating) return null;

  // 'reconciling' = primary wait timed out, run is being polled in
  // background. We don't surface this distinction in the label — the user
  // just cares that something is happening — but keep it in the data
  // attribute so debug tooling can see it.
  return (
    <motion.div
      role="status"
      aria-live="polite"
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      data-status={run?.status ?? "running"}
      data-trigger={run?.trigger ?? "manual"}
      className={cn(
        "glass-card-strong inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-[11px] font-medium text-foreground/80",
        className,
      )}
    >
      <motion.span
        className="inline-block w-1.5 h-1.5 rounded-full bg-[hsl(292,78%,63%)]"
        animate={{ opacity: [0.4, 1, 0.4] }}
        transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut" }}
      />
      <span>正在生成</span>
    </motion.div>
  );
}
