/**
 * card chat 的装配原语 —— 从 proactive-ai-frontend 的 ChatDetailView 抽出
 * （那边改 import，本文件是双端真源）：thread session key 推导、喂给 agent
 * 的 <card_context> 构造、聊天顶部的卡片 context chip。移动端壳
 * （ChatDetailView + vaul drawer）与桌面壳（apps/web ZebraCardChat 面板）
 * 共同消费。
 */
import { ChevronUp } from "lucide-react";
import { brandSvg, detectToolIcon, type ChatCard } from "./chat-card-presentation";

export function cardThreadSessionKey(card: ChatCard, runId?: string): string {
  const raw = (runId ?? String(card.id)).trim();
  return raw.startsWith("card-thread-") ? raw : `card-thread-${raw}`;
}

export function buildCardContext(card: ChatCard): Record<string, unknown> {
  return {
    title: card.title,
    category: card.category,
    tag: card.tag,
    // Card type + owning schedule task: the agent's <reminder_cards> prompt
    // branch keys on these (don't "execute" a nudge; edit the right task).
    ...(card.cardKind ? { cardKind: card.cardKind } : {}),
    ...(card.scheduleTaskId ? { scheduleTaskId: card.scheduleTaskId } : {}),
    summary: card.line1,
    whyNow: card.whyNow ?? card.line1,
    sources: card.sourceApps ?? [],
    primaryAction: card.detail?.willExecute
      ? { label: card.detail.willExecute, type: "confirm" }
      : undefined,
    detail: card.detail,
  };
}

export function CardContextHeaderSlot({
  card,
  onOpen,
}: {
  card: ChatCard;
  onOpen: () => void;
}) {
  const plan = card.detail?.executionPlan ?? [];
  return (
    <div className="px-4 pt-3 pb-1">
      <button
        type="button"
        aria-label="View card details"
        onClick={onOpen}
        className="w-full rounded-2xl px-4 py-3 border border-foreground/8 text-left group"
        style={{
          background: "rgba(255,255,255,0.5)",
          backdropFilter: "blur(16px)",
          WebkitBackdropFilter: "blur(16px)",
        }}
      >
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-foreground/40 mb-1">
              Context
            </p>
            <p className="text-[13px] text-foreground/80 leading-relaxed line-clamp-2">
              {/* Reminder cards have no action — willExecute is just the
                  button label ("Done"); show the nudge itself. */}
              {card.cardKind === "reminder"
                ? card.line1
                : card.detail?.willExecute || card.line1}
            </p>
            {plan.length > 0 && (
              <div className="mt-2 flex flex-col gap-1">
                {plan.slice(0, 3).map((step, i) => {
                  const icon = detectToolIcon(step.text + " " + step.tool);
                  return (
                    <div key={i} className="flex items-center gap-1.5 min-w-0">
                      <span
                        className="w-4 h-4 rounded-[5px] flex items-center justify-center overflow-hidden border border-foreground/10 shrink-0"
                        style={{ background: icon.kind === "brand" ? "#fff" : "rgba(255,255,255,0.85)" }}
                      >
                        {icon.kind === "brand" ? (
                          <div className="w-[11px] h-[11px]">{brandSvg(icon.name)}</div>
                        ) : (
                          <icon.Icon size={9} strokeWidth={2} className="text-foreground/70" />
                        )}
                      </span>
                      <span className="text-[11.5px] text-foreground/60 truncate leading-snug">
                        {step.text}
                      </span>
                    </div>
                  );
                })}
                {plan.length > 3 && (
                  <span className="text-[10.5px] text-foreground/40 pl-[22px]">
                    +{plan.length - 3} more
                  </span>
                )}
              </div>
            )}
          </div>
          <ChevronUp
            size={13}
            className="text-foreground/30 group-hover:text-foreground/60 transition-colors shrink-0 mt-0.5"
          />
        </div>
      </button>
    </div>
  );
}
