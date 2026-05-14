import { MessageCircle, Pencil, X, Zap } from "lucide-react";

import { Drawer, DrawerContent } from "@/components/ui/drawer";
import type { Intent } from "@/types/constellation";

import { categoryFor } from "./categoryMeta";

interface CardDrawerDetailProps {
  intent: Intent | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApprove: (intent: Intent) => void;
  onModify?: (intent: Intent) => void;
  onDismiss?: (intent: Intent) => void;
  onChat?: (intent: Intent) => void;
}

export default function CardDrawerDetail({
  intent,
  open,
  onOpenChange,
  onApprove,
  onModify,
  onDismiss,
  onChat,
}: CardDrawerDetailProps) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="max-h-[88vh] overflow-hidden border-foreground/10 bg-background/95 backdrop-blur-xl">
        {intent ? <Body intent={intent} onApprove={onApprove} onModify={onModify} onDismiss={onDismiss} onChat={onChat} /> : null}
      </DrawerContent>
    </Drawer>
  );
}

function Body({
  intent,
  onApprove,
  onModify,
  onDismiss,
  onChat,
}: {
  intent: Intent;
  onApprove: (intent: Intent) => void;
  onModify?: (intent: Intent) => void;
  onDismiss?: (intent: Intent) => void;
  onChat?: (intent: Intent) => void;
}) {
  const cat = categoryFor(intent.category);
  const Icon = cat.icon;
  const detail = intent.detail;
  const hasScores = (detail?.scores?.length ?? 0) > 0;
  const hasPlan = (detail?.executionPlan?.length ?? 0) > 0;
  const hasSources = (detail?.dataSources?.length ?? 0) > 0;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="overflow-y-auto px-5 pt-2 pb-4 flex-1">
        <div className="flex items-center gap-1.5 mb-3">
          <Icon size={14} strokeWidth={1.5} className="text-foreground/50" />
          <span className="text-xs font-semibold tracking-wide text-foreground/50 uppercase">
            {cat.label}
          </span>
          {intent.tag && (
            <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-foreground/10 text-foreground/50">
              {intent.tag}
            </span>
          )}
          {intent.status === "processing" && (
            <span className="ml-auto inline-flex items-center gap-1 text-[11px] font-semibold text-amber-600">
              <span className="w-2 h-2 rounded-full border-[1.5px] border-amber-500 border-t-transparent animate-spin" />
              processing
            </span>
          )}
          {intent.status === "done" && (
            <span className="ml-auto text-[11px] font-bold text-green-600 uppercase tracking-wider">
              done
            </span>
          )}
        </div>

        <h2 className="text-display text-[20px] leading-snug text-foreground mb-2.5 font-semibold">
          {intent.title}
        </h2>

        {intent.line1 && (
          <p className="text-[14px] text-foreground/75 leading-relaxed mb-2">
            {intent.line1}
          </p>
        )}
        {intent.line2 && (
          <p className="text-[12px] text-foreground/55 leading-relaxed mb-4">
            {intent.line2}
          </p>
        )}

        {hasScores && (
          <div
            className="grid gap-2 mb-4"
            style={{
              gridTemplateColumns: `repeat(${detail!.scores.length}, minmax(0, 1fr))`,
            }}
          >
            {detail!.scores.map((s) => (
              <div key={s.label} className="rounded-xl bg-foreground/5 py-2.5 text-center">
                <div className="text-lg font-bold text-foreground/85">{s.value}</div>
                <div className="text-[11px] text-foreground/50 mt-0.5">{s.label}</div>
              </div>
            ))}
          </div>
        )}

        {detail?.willExecute && (
          <div
            className="rounded-xl p-3.5 mb-4 border border-pink-200/40"
            style={{
              background:
                "linear-gradient(135deg, rgba(225,92,230,0.10) 0%, rgba(225,92,230,0.04) 100%)",
            }}
          >
            <div className="text-[11px] font-bold mb-1 uppercase tracking-wider">
              <span className="bg-gradient-to-r from-[hsl(292,78%,63%)] to-[hsl(330,80%,65%)] bg-clip-text text-transparent">
                Will execute on confirm
              </span>
            </div>
            <p className="text-[13.5px] text-foreground/85 leading-relaxed">
              {detail.willExecute}
            </p>
          </div>
        )}

        {hasPlan && (
          <div className="mb-4">
            <div className="text-[11px] font-bold text-foreground/55 uppercase tracking-wider mb-2">
              Execution Plan
            </div>
            <div className="flex flex-col gap-1.5">
              {detail!.executionPlan.map((step, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 rounded-xl bg-foreground/[0.04] px-3 py-2"
                >
                  <Zap size={12} strokeWidth={1.5} className="text-foreground/40 shrink-0" />
                  <span className="text-[13px] text-foreground/75 flex-1">{step.text}</span>
                  <span className="text-[11px] text-foreground/40 bg-foreground/5 px-2 py-0.5 rounded-full whitespace-nowrap">
                    {step.tool}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {hasSources && (
          <div className="mb-4">
            <div className="text-[11px] font-bold text-foreground/55 uppercase tracking-wider mb-1.5">
              Sources
            </div>
            <div className="flex flex-wrap gap-1.5">
              {detail!.dataSources.map((source, i) => (
                <div
                  key={i}
                  className="inline-flex items-center px-2.5 py-1 rounded-full bg-foreground/[0.05] border border-foreground/[0.06] text-[12px] font-medium text-foreground/70"
                >
                  {source}
                </div>
              ))}
            </div>
          </div>
        )}

        {detail?.impact && (
          <p className="text-[13px] text-foreground/55 mb-1">
            <span className="font-semibold text-foreground/70">Impact:</span> {detail.impact}
          </p>
        )}
        {detail?.permissions && (
          <p className="text-[13px] text-foreground/55 mb-2">
            <span className="font-semibold text-foreground/70">Permissions:</span>{" "}
            {detail.permissions}
          </p>
        )}
      </div>

      <div
        className="px-5 pb-5 pt-3 border-t border-foreground/5 flex items-center gap-2"
        style={{ paddingBottom: "max(env(safe-area-inset-bottom, 0px) + 16px, 20px)" }}
      >
        {onDismiss && (
          <button
            onClick={() => onDismiss(intent)}
            className="flex items-center justify-center gap-1.5 px-3 h-11 rounded-xl bg-foreground/5 hover:bg-foreground/10 transition-colors text-[13px] font-medium text-foreground/55"
            aria-label="Dismiss"
          >
            <X size={14} strokeWidth={1.5} />
          </button>
        )}
        {onChat && (
          <button
            onClick={() => onChat(intent)}
            className="flex items-center justify-center gap-1.5 px-3 h-11 rounded-xl bg-foreground/5 hover:bg-foreground/10 transition-colors text-[13px] font-medium text-foreground/55"
            aria-label="Open chat"
          >
            <MessageCircle size={14} strokeWidth={1.5} />
          </button>
        )}
        {onModify && (
          <button
            onClick={() => onModify(intent)}
            className="flex-1 flex items-center justify-center gap-2 h-11 rounded-xl bg-foreground/5 hover:bg-foreground/10 transition-colors text-[14px] font-medium text-foreground/65"
          >
            <Pencil size={14} strokeWidth={1.5} />
            Modify
          </button>
        )}
        <button
          onClick={() => onApprove(intent)}
          className="flex-1 flex items-center justify-center gap-2 h-11 rounded-xl bg-foreground text-background text-[14px] font-semibold hover:bg-foreground/85 transition-colors"
        >
          <Zap size={14} strokeWidth={2} />
          Approve
        </button>
      </div>
    </div>
  );
}
