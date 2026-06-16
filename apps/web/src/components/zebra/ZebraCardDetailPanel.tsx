import { X, Check, Lock as LockIcon, Loader2, MessageCircle } from "lucide-react";
import { useCardExecutionRun } from "@pin-ai/state";
import { CATEGORIES, categoryLabel, DrawerDetailBody, type Intent, Text } from "@pin-ai/ui-web";

/**
 * Desktop (zebra) card detail — the iOS bottom-drawer content re-housed in a
 * 440px slide-over panel. 数据与动作语义完全沿用 production CardDrawerContent
 * （frontend 为真源）：DrawerDetailBody 读 useCardExecutionRun 的 plan /
 * drafts / dangerous_actions / risks（fanout 预跑或真实执行的缓存），动作行
 * 统一为 [Dismiss] [Done] [Chat | Approve]（Steer 已退役——steering 发生在
 * chat 里）。zebra 原型的 reflection 卡分支是 mock 设计，真实 IntentCard
 * 无此 kind，不移植。
 */
export default function ZebraCardDetailPanel({
  card,
  completed,
  pending,
  onClose,
  onExecute,
  onDismiss,
  onComplete,
  onChat,
}: {
  card: Intent;
  completed: boolean;
  pending: boolean;
  onClose: () => void;
  onExecute: (card: Intent) => void;
  onDismiss: (card: Intent) => void;
  onComplete: (card: Intent) => void;
  onChat: (card: Intent) => void;
}) {
  const cat = CATEGORIES[card.category] ?? CATEGORIES.life;
  const Icon = cat.icon;
  // The hook accepts the card's original string id (gen.*_card_NN) and
  // internally maps it to session_key. Read-only pre-review — no bootstrap.
  const run = useCardExecutionRun(card.originalId ?? null);
  const showCompletedView = completed || run.snapshot?.status === "done";

  return (
    <div className="flex flex-col h-full">
      {/* Panel header */}
      <div className="flex items-center justify-between px-5 pt-5 pb-2 shrink-0">
        <Text variant="caption" weight="bold" className="uppercase tracking-[0.18em] text-foreground/45">
          Card Detail
        </Text>
        <button
          onClick={onClose}
          className="p-2 -mr-2 rounded-full hover:bg-foreground/[0.06] transition-colors"
          aria-label="Close detail"
        >
          <X size={18} strokeWidth={1.6} className="text-foreground/60" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-5">
        {/* Category */}
        <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
          <Icon size={14} strokeWidth={1.5} className="text-foreground/50" />
          <span className="text-xs font-semibold tracking-wide text-foreground/50 uppercase">{categoryLabel(card.category)}</span>
          {card.tag && (
            <Text variant="caption" weight="bold" className="px-1.5 py-0.5 rounded-full bg-foreground/10 text-foreground/50">
              {card.tag}
            </Text>
          )}
          {card.complexity === "simple" && (
            <span
              className="inline-flex items-center gap-1 text-caption font-bold px-1.5 py-0.5 rounded-full bg-primary/10 text-primary"
              title="Low-risk task — usually safe to approve as-is"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-primary" />
              Quick approve
            </span>
          )}
        </div>

        {/* Title */}
        <h3 className="text-display text-subheading leading-snug text-foreground mb-1.5 font-semibold">{card.title}</h3>

        {/* Concise "what to do" summary. Reminder cards have no action —
            willExecute is just the button label; show the nudge itself. */}
        <Text variant="bodySm" className="block text-foreground/55 leading-snug mb-3">
          {card.reminder ? card.line1 : card.detail?.willExecute || card.line1}
        </Text>

        {/* Detail sections — live plan / drafts / dangerous_actions / risks
            from the latest propose_action snapshot, static card fallback. */}
        {card.detail && (
          <DrawerDetailBody
            card={card}
            runSnapshot={run.snapshot}
            lastMessagePayload={showCompletedView ? null : run.lastMessagePayload}
            sideEffects={run.snapshot?.result?.side_effects ?? []}
          />
        )}
      </div>

      {/* Actions — pinned to panel bottom; unified action model
          [Dismiss] [Done] [Chat | Approve] */}
      <div className="shrink-0 flex items-center gap-2 px-5 py-4 border-t border-foreground/[0.06]">
        {showCompletedView ? (
          <button
            onClick={onClose}
            className="flex-1 flex items-center justify-center gap-1.5 px-4 py-3 rounded-xl bg-foreground/5 hover:bg-foreground/10 transition-colors text-bodySm font-medium text-foreground/55"
          >
            Close
          </button>
        ) : (
          <>
            <button
              onClick={() => onDismiss(card)}
              disabled={pending}
              className="flex items-center justify-center gap-1.5 px-4 py-3 rounded-xl bg-foreground/5 hover:bg-foreground/10 transition-colors text-bodySm font-medium text-foreground/55 disabled:opacity-45 disabled:cursor-default"
            >
              <X size={13} strokeWidth={2} /> Dismiss
            </button>
            <button
              onClick={() => onComplete(card)}
              disabled={pending}
              className="flex items-center justify-center gap-1 px-3 py-3 rounded-xl bg-foreground/5 hover:bg-foreground/10 transition-colors text-label font-medium text-foreground/55 disabled:opacity-45 disabled:cursor-default"
            >
              <Check size={12} strokeWidth={2.5} /> Done
            </button>
            {card.reminder ? (
              <button
                onClick={() => onChat(card)}
                disabled={pending}
                className="flex-1 flex items-center justify-center gap-1.5 px-4 py-3 rounded-xl bg-foreground text-background text-bodySm font-semibold hover:bg-foreground/85 transition-colors disabled:opacity-70 disabled:cursor-default"
              >
                <MessageCircle size={13} strokeWidth={2} /> Chat
              </button>
            ) : (
              <button
                onClick={() => onExecute(card)}
                disabled={pending}
                className="flex-1 flex items-center justify-center gap-1.5 px-4 py-3 rounded-xl bg-foreground text-background text-bodySm font-semibold hover:bg-foreground/85 transition-colors disabled:opacity-70 disabled:cursor-default"
              >
                {pending ? (
                  <><Loader2 size={13} className="animate-spin" /> Opening...</>
                ) : card.locked ? (
                  <><LockIcon size={13} strokeWidth={2.5} /> Approve</>
                ) : (
                  <><Check size={13} strokeWidth={2.5} /> Approve</>
                )}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
