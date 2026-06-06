import { X, Pencil, Check, Lock as LockIcon, Loader2 } from "lucide-react";
import { useCardExecutionRun } from "@/hooks/useCardExecutionRun";
import { DrawerDetailBody } from "./CardDrawerDetail";
import { CATEGORIES, type Intent } from "./cardModel";

/* ── Drawer card detail ──
 *
 * Subscribes to the same `useCardExecutionRun` hook the chat detail
 * view uses, keyed by the card's original string id (which the hook
 * maps to chat-stream session_key `card-thread-<id>`). That lets the
 * drawer pre-render plan / Generated draft / Approving will let agent
 * / Risks pulled from the latest propose_action's structured args,
 * cached via `lastMessagePayload`. Without this, DrawerDetailBody
 * falls back to `card.detail.executionPlan` (always empty for real
 * cards) and the drawer looks like a thin summary card.
 */
export default function CardDrawerContent({
  card,
  completed,
  pending,
  onExecute,
  onClose,
  onModify,
  onDismiss,
}: {
  card: Intent;
  completed: boolean;
  pending: boolean;
  onExecute: (card: Intent) => void;
  onClose: () => void;
  onModify: (card: Intent) => void;
  onDismiss: (card: Intent) => void;
}) {
  const cat = CATEGORIES[card.category];
  const Icon = cat.icon;
  // The hook accepts the card's original string id (gen.*_card_NN) and
  // internally maps it to session_key. We never set bootstrap here —
  // the drawer is read-only pre-review; firing a bootstrap turn from
  // a tap would surprise the user. The chat detail view fires it on
  // Approve when the thread is empty.
  const run = useCardExecutionRun(card.originalId ?? null);
  const showCompletedView = completed || run.snapshot?.status === "done";

  return (
    <div className="px-5 pb-5 pt-1.5 overflow-y-auto max-h-[88vh]">
      {/* Category */}
      <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
        <Icon size={14} strokeWidth={1.5} className="text-foreground/50" />
        <span className="text-xs font-semibold tracking-wide text-foreground/50 uppercase">{cat.label}</span>
        {card.tag && (
          <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-foreground/10 text-foreground/50">
            {card.tag}
          </span>
        )}
        {card.complexity === "simple" && (
          <span
            className="inline-flex items-center gap-1 text-[11px] font-bold px-1.5 py-0.5 rounded-full"
            style={{ background: "rgba(225,92,230,0.12)", color: "#E15CE6" }}
            title="Low-risk task — usually safe to approve as-is"
          >
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: "#E15CE6" }} />
            Quick approve
          </span>
        )}
      </div>

      {/* Title */}
      <h3 className="text-display text-[18px] leading-snug text-foreground mb-1.5 font-semibold">{card.title}</h3>

      {/* Concise "what to do" summary (gray, action-oriented) */}
      <p className="text-[13.5px] text-foreground/55 leading-snug mb-3">
        {card.detail?.willExecute || card.line1}
      </p>

      {/* Detail sections — DrawerDetailBody reads the latest
          propose_action's structured args from `lastMessagePayload`
          (plan / drafts / dangerous_actions / risks), falling back
          to the card's static detail when the agent hasn't paused
          yet. */}
      {card.detail && (
        <DrawerDetailBody
          card={card}
          runSnapshot={run.snapshot}
          lastMessagePayload={showCompletedView ? null : run.lastMessagePayload}
          sideEffects={run.snapshot?.result?.side_effects ?? []}
        />
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 mt-5">
        {showCompletedView ? (
          <button
            onClick={onClose}
            className="flex-1 flex items-center justify-center gap-1.5 px-4 py-3 rounded-xl bg-foreground/5 hover:bg-foreground/10 transition-colors text-[13px] font-medium text-foreground/55"
          >
            Close
          </button>
        ) : (
          <>
            <button
              onClick={() => onDismiss(card)}
              disabled={pending}
              className="flex items-center justify-center gap-1.5 px-4 py-3 rounded-xl bg-foreground/5 hover:bg-foreground/10 transition-colors text-[13px] font-medium text-foreground/55 disabled:opacity-45 disabled:cursor-default"
            >
              <X size={13} strokeWidth={2} /> Dismiss
            </button>
            {!card.locked && (
              <button
                onClick={() => onModify(card)}
                disabled={pending}
                className="flex items-center justify-center gap-1 px-3 py-3 rounded-xl bg-foreground/5 hover:bg-foreground/10 transition-colors text-[12px] font-medium text-foreground/55 disabled:opacity-45 disabled:cursor-default"
              >
                <Pencil size={11} strokeWidth={2} /> Steer
              </button>
            )}
            <button
              onClick={() => onExecute(card)}
              disabled={pending}
              className="flex-1 flex items-center justify-center gap-1.5 px-4 py-3 rounded-xl bg-foreground text-background text-[13px] font-semibold hover:bg-foreground/85 transition-colors disabled:opacity-70 disabled:cursor-default"
            >
              {pending ? (
                <><Loader2 size={13} className="animate-spin" /> Opening...</>
              ) : card.locked ? (
                <><LockIcon size={13} strokeWidth={2.5} /> Approve</>
              ) : (
                <><Check size={13} strokeWidth={2.5} /> Approve</>
              )}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
