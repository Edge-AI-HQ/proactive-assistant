import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Bell, CheckCircle2, Circle, CircleAlert, ListChecks, Loader2, XCircle,
} from "lucide-react";
import {
  deriveCardUiStatus,
  isReminderCard,
  type CardOutcome,
  type CardRunStatus,
  type CardRunUiStatus,
  type CardScore,
  type IntentCard,
} from "@pin-ai/core";
import {
  basketMeta,
  connectorSlugFromIntentKey,
  getToolkit,
  realCardToLovableIntent,
  sourceAppDisplay,
  useCardActions,
  type Intent, Text,
} from "@/ui-web";
import type { VisibleCardEntry } from "@pin-ai/core";
import ZebraCardChat from "./ZebraCardChat";
import ZebraCardDetailPanel from "./ZebraCardDetailPanel";

/** Timeline 行 = 真实 IntentCard + run 元数据（与 production CardTimeline
 *  的投影一致）。 */
interface TimelineCard {
  card: IntentCard;
  runId: string;
  runDate: string;
  score: CardScore | null;
  runStatus: CardRunStatus | null;
  latestOutcome: CardOutcome | null;
}

type FilterId = "all" | "processing" | "needs_input" | "ready" | "resolved";

const FILTERS: { id: FilterId; label: string }[] = [
  { id: "all", label: "All" },
  { id: "processing", label: "Running" },
  { id: "needs_input", label: "Needs input" },
  { id: "ready", label: "Ready" },
  { id: "resolved", label: "Done" },
];

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString([], { hour: "numeric", minute: "2-digit" });
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * Desktop (zebra) TASKS — Linear-style split view。左：可过滤、按天分组的
 * 真实卡历史（/api/cards 全量，与 production CardTimeline 同一投影 + 状态
 * 推导）；右：常驻执行 pane —— engaged（有 run / 聊过）的卡渲染真实
 * card chat（ConversationView），normal 卡渲染 detail 面板。Shell 在
 * /tasks 路由把 onOpenChat 提升到这里（chatTarget），approve 后右 pane
 * 原地切换到 chat。
 */
export default function ZebraTasksSplit({
  entries,
  cardActions,
  chatTarget,
  onConsumeChatTarget,
}: {
  entries: VisibleCardEntry[];
  cardActions: ReturnType<typeof useCardActions>;
  /** Shell 的 onOpenChat 在 /tasks 上下文的着陆点（approve/chat 动作）。 */
  chatTarget: { cardId: string; bootstrap?: string } | null;
  onConsumeChatTarget: () => void;
}) {
  const [filter, setFilter] = useState<FilterId>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // approve/chat 动作后右 pane 进 chat 模式（带 bootstrap）；点选其它卡重置。
  const [chatMode, setChatMode] = useState<{ cardId: string; bootstrap?: string } | null>(null);

  const timeline: (TimelineCard & { runUi: CardRunUiStatus; resolved: boolean })[] = useMemo(
    () =>
      entries.map((entry) => {
        const resolved =
          cardActions.dismissedIds.has(entry.card.id) ||
          cardActions.doneIds.has(entry.card.id) ||
          entry.latestOutcome === "complete" ||
          entry.latestOutcome === "dismiss" ||
          entry.latestOutcome === "snooze";
        const runUi: CardRunUiStatus = resolved
          ? "normal"
          : deriveCardUiStatus({
              runStatus: entry.runStatus,
              latestOutcome: entry.latestOutcome,
              optimisticProcessing: cardActions.processingIds.has(entry.card.id),
              chatted: cardActions.chattedIds.has(entry.card.id),
            });
        return {
          card: entry.card,
          runId: entry.runId,
          runDate: entry.runCompletedAt,
          score: entry.score,
          runStatus: entry.runStatus,
          latestOutcome: entry.latestOutcome,
          runUi,
          resolved,
        };
      }),
    [entries, cardActions.dismissedIds, cardActions.doneIds, cardActions.processingIds, cardActions.chattedIds],
  );

  // Shell 提升的 chat 意图落地：选中该卡 + 右 pane 切 chat。
  useEffect(() => {
    if (!chatTarget) return;
    setSelectedId(chatTarget.cardId);
    setChatMode({ cardId: chatTarget.cardId, bootstrap: chatTarget.bootstrap });
    onConsumeChatTarget();
  }, [chatTarget, onConsumeChatTarget]);

  const counts = useMemo(() => {
    const c: Record<FilterId, number> = { all: timeline.length, processing: 0, needs_input: 0, ready: 0, resolved: 0 };
    for (const t of timeline) {
      if (t.resolved) c.resolved += 1;
      else if (t.runUi === "processing") c.processing += 1;
      else if (t.runUi === "needs_input") c.needs_input += 1;
      else if (t.runUi === "ready") c.ready += 1;
    }
    return c;
  }, [timeline]);

  const matches = (t: { runUi: CardRunUiStatus; resolved: boolean }) =>
    filter === "all" ||
    (filter === "resolved" ? t.resolved : !t.resolved && t.runUi === filter);

  const sections = useMemo(() => {
    const grouped = new Map<string, typeof timeline>();
    for (const t of timeline) {
      if (!matches(t)) continue;
      const label = formatDate(t.runDate);
      if (!grouped.has(label)) grouped.set(label, []);
      grouped.get(label)!.push(t);
    }
    return [...grouped.entries()];
    // eslint 不在本包跑 hooks 规则；matches 是纯函数，依赖 filter。
  }, [timeline, filter]);

  const selected = timeline.find((t) => t.card.id === selectedId) ?? null;
  const selectedEngaged =
    selected !== null &&
    !selected.resolved &&
    (selected.runUi !== "normal" || cardActions.chattedIds.has(selected.card.id));
  const showChat =
    selected !== null && (selectedEngaged || chatMode?.cardId === selected.card.id);

  // Browser split (live view beside the chat) in the right pane hides the task
  // list so the execution view goes full width. Reset whenever we leave chat
  // (detail / empty / a different card) — ConversationView unmounts then and
  // can't report back to false on its own.
  const [browserSplit, setBrowserSplit] = useState(false);
  useEffect(() => {
    if (!showChat) setBrowserSplit(false);
  }, [showChat]);

  const selectedIntent: Intent | null = selected
    ? realCardToLovableIntent(selected.card, selected.resolved ? "done" : selected.runUi)
    : null;

  return (
    // Capped + centered content column; the right pane stops stretching on
    // ultra-wide windows instead of scattering the execution view.
    <div
      className={`h-full flex gap-5 px-8 pt-10 pb-6 w-full mx-auto ${
        browserSplit ? "max-w-none" : "max-w-[1320px]"
      }`}
    >
      {/* Left — task list (hidden while the browser split takes over) */}
      <div
        className={`w-[340px] shrink-0 flex-col min-h-0 ${browserSplit ? "hidden" : "flex"}`}
      >
        <h1 className="text-display text-2xl text-foreground mb-1">Tasks</h1>
        <p className="text-sm text-muted-foreground mb-4">AI is running these for you</p>

        {/* Filter chips */}
        <div className="flex items-center gap-1.5 mb-4 flex-wrap">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`px-2.5 py-1 rounded-full text-caption font-medium transition-colors ${
                filter === f.id
                  ? "bg-foreground text-background"
                  : "bg-foreground/[0.05] text-foreground/55 hover:bg-foreground/10"
              }`}
            >
              {f.label}
              <span className={`ml-1 tabular-nums ${filter === f.id ? "text-background/70" : "text-foreground/35"}`}>
                {counts[f.id]}
              </span>
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto min-h-0 pr-1 -mr-1">
          {sections.map(([dateLabel, items]) => (
            <div key={dateLabel} className="mb-4">
              <Text variant="caption" weight="semibold" className="text-muted-foreground uppercase tracking-wider mb-2 block">
                {dateLabel}
              </Text>
              <div className="space-y-1.5">
                {items.map((t) => {
                  const meta = basketMeta(t.card.goalBasket);
                  const connectorSlug = connectorSlugFromIntentKey(t.card.intentKey);
                  const toolkit = connectorSlug ? getToolkit(connectorSlug) : null;
                  const reminder = isReminderCard(t.card);
                  const CatIcon = toolkit?.icon ?? (reminder ? Bell : meta.icon);
                  const isSelected = selectedId === t.card.id;
                  const previewText = t.resolved
                    ? cardActions.dismissedIds.has(t.card.id) || t.latestOutcome === "dismiss"
                      ? "Dismissed"
                      : "Completed"
                    : t.runUi === "processing"
                      ? "Processing..."
                      : t.runUi === "needs_input"
                        ? "Waiting for your input"
                        : t.runUi === "ready"
                          ? "Ready for review"
                          : t.runUi === "failed"
                            ? "Failed"
                            : reminder
                              ? t.card.summary
                              : t.card.primaryAction
                                ? t.card.primaryAction.label
                                : t.card.sourceApps.map((s) => sourceAppDisplay(s).label).join(" · ");
                  return (
                    <button
                      key={`${t.runId}-${t.card.id}`}
                      onClick={() => {
                        setSelectedId(t.card.id);
                        setChatMode(null);
                      }}
                      className={`w-full text-left rounded-2xl px-3.5 py-3 transition-colors border ${
                        isSelected
                          ? "bg-white/70 border-foreground/10 shadow-sm"
                          : "bg-white/35 border-transparent hover:bg-white/55"
                      }`}
                    >
                      <div className="flex items-center gap-2.5">
                        <span className="text-foreground/50 shrink-0">
                          <CatIcon size={15} />
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <p className={`text-label font-medium leading-snug line-clamp-1 flex-1 ${t.resolved ? "text-foreground/35 line-through" : "text-foreground"}`}>
                              {t.card.title}
                            </p>
                            <span className="shrink-0 w-[16px] h-[16px] inline-flex items-center justify-center">
                              {t.resolved ? (
                                <CheckCircle2 size={14} className="text-green-500/60" />
                              ) : t.runUi === "processing" ? (
                                <Loader2 size={14} className="text-amber-500 animate-spin" />
                              ) : t.runUi === "needs_input" ? (
                                <CircleAlert size={14} className="text-amber-500 animate-pulse" />
                              ) : t.runUi === "ready" ? (
                                <CheckCircle2 size={14} className="text-green-500" />
                              ) : t.runUi === "failed" ? (
                                <XCircle size={14} className="text-rose-500" />
                              ) : (
                                <Circle size={14} className="text-rose-400" fill="currentColor" />
                              )}
                            </span>
                          </div>
                          <div className="flex items-center gap-1 mt-1">
                            <p className="text-micro text-foreground/40 truncate flex-1">{previewText}</p>
                            <Text variant="micro" className="text-muted-foreground shrink-0">{formatTime(t.runDate)}</Text>
                          </div>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          {timeline.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
              <div className="glass-card p-4 rounded-full">
                <ListChecks size={24} strokeWidth={1.5} className="text-foreground/40" />
              </div>
              <Text variant="bodySm" className="block text-display text-foreground/60">No cards yet</Text>
              <Text variant="bodySm" className="block text-foreground/40 leading-relaxed max-w-[240px]">
                Cards appear here as PIN AI generates and runs them.
              </Text>
            </div>
          )}
        </div>
      </div>

      {/* Right — execution pane */}
      <div className="flex-1 min-w-0 rounded-3xl overflow-hidden glass-card-strong relative">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={selected ? `${selected.card.id}-${showChat ? "chat" : "detail"}` : "empty"}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="absolute inset-0"
          >
            {selected && selectedIntent ? (
              showChat ? (
                <ZebraCardChat
                  card={selected.card}
                  bootstrap={chatMode?.cardId === selected.card.id ? chatMode.bootstrap : undefined}
                  onBack={() => {
                    setChatMode(null);
                    setSelectedId(null);
                  }}
                  onDone={async () => {
                    const ok = await cardActions.complete(selected.card);
                    if (ok) setSelectedId(null);
                    return ok;
                  }}
                  onComment={(text) => cardActions.textFeedback(selected.card, text)}
                  onTurnDone={() => cardActions.clearProcessing(selected.card.id)}
                  enableBrowserSplit
                  onBrowserSplitChange={setBrowserSplit}
                />
              ) : (
                <ZebraCardDetailPanel
                  card={selectedIntent}
                  completed={selected.resolved}
                  pending={false}
                  onClose={() => setSelectedId(null)}
                  onExecute={() => void cardActions.confirm(selected.card)}
                  onDismiss={() => {
                    void cardActions.dismiss(selected.card);
                    setSelectedId(null);
                  }}
                  onComplete={() => void cardActions.complete(selected.card)}
                  onChat={() => cardActions.openChat(selected.card)}
                />
              )
            ) : (
              <div className="h-full flex items-center justify-center">
                <div className="text-center px-8">
                  <ListChecks size={28} strokeWidth={1.5} className="text-foreground/25 mx-auto mb-3" />
                  <Text variant="bodySm" className="block text-foreground/45">Select a task to see its execution</Text>
                </div>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
