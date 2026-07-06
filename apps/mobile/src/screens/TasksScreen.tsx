/**
 * TASKS 页——web CardTimeline 的 RN 对应物：日期分组（today/yesterday/Mon d）
 * + 玻璃行（分类图标 + 标题 + 状态环 + previewText + 时间）。状态语义逐字对齐
 * web CardTimeline:119-134：resolved（划线）来自壳级共享的乐观 id 集
 * （dismissedIds/doneIds，mount 时已从 /feedback/{dismissed,completed} 恢复，
 * dismiss/done 立即划线）；runUi 由 core deriveCardUiStatus 从服务端
 * runStatus + 乐观 processing/chatted 合成。
 *
 * 点行分流（对齐 web CardTimeline:166）：活跃卡（runUi!=="normal"）或聊过的卡
 * → card chat；新卡 → 详情面板，复用 NOW 同款 CardDetailSheet + 壳级
 * CardActionsProvider 单实例（动作与集合两屏唯一真源）。
 */
import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, SectionList, StyleSheet, Text, View } from "react-native";
import {
  Bell,
  CheckCircle2,
  Circle,
  CircleAlert,
  Loader2,
  Sparkles,
  XCircle,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import {
  basketToLovableCategory,
  connectorSlugFromIntentKey,
  deriveCardUiStatus,
  isReminderCard,
  sourceAppMeta,
  type IntentCard,
  type VisibleCardEntry,
} from "@pin-ai/core";
import { useCardsQuery } from "@pin-ai/state";

import i18n from "../i18n";

import { useCardActionsContext } from "../components/app/CardActionsProvider";
import PageHeader from "../components/app/PageHeader";
import { usePageActive } from "../components/app/KeepAlivePage";
import CardDetailSheet from "../components/now/CardDetailSheet";
import { CATEGORIES } from "../components/now/SphereCards";
import { GlassCard } from "../ui/GlassCard";
import { getToolkitIcon } from "../lib/toolkit-icons";
import type { HeaderProps } from "./AmbientScreen";

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  // web CardTimeline 用 Intl.RelativeTimeFormat(numeric:"auto") 拿本地化的
  // today/yesterday 词——Hermes 没实现 RelativeTimeFormat（构造即崩，见
  // lib/format.ts 文件头），照该文件先例手写 en CLDR 同款措辞（渲染处统一
  // toUpperCase，与 web 的 uppercase class 等价）。
  if (d.toDateString() === today.toDateString()) return "today";
  if (d.toDateString() === yesterday.toDateString()) return "yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** 行左侧分类图标（对齐 web CardTimeline:112-117 三选一）：连接器卡 → toolkit
 *  语义图标（lucide，Gmail→Mail / Calendar→Calendar…，与 web getToolkit 同源）；
 *  连接器解析失败再降级提醒卡 → Bell；否则 basket 类目图标。绝不用通用 Plug
 *  （web 也不用）。类目复用 NOW 球面同款 CATEGORIES，保证同一卡两处图标一致。 */
function categoryIcon(card: IntentCard) {
  const connectorSlug = connectorSlugFromIntentKey(card.intentKey);
  const toolkit = connectorSlug ? getToolkitIcon(connectorSlug) : null;
  if (toolkit) return toolkit;
  if (isReminderCard(card)) return Bell;
  const cat = basketToLovableCategory(card.goalBasket);
  return (CATEGORIES[cat] ?? CATEGORIES.life).icon;
}

/** needs_input 徽章呼吸闪烁（web animate-pulse 的 RN 对应物）。
 *  页面隐藏时停帧（keep-alive 常驻后无限循环不能空跑）。 */
function Pulse({ children }: { children: ReactNode }) {
  const pageActive = usePageActive();
  const o = useSharedValue(1);
  useEffect(() => {
    if (!pageActive) return;
    o.value = withRepeat(
      withTiming(0.35, { duration: 700, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
    return () => {
      cancelAnimation(o);
      o.value = 1;
    };
  }, [o, pageActive]);
  const style = useAnimatedStyle(() => ({ opacity: o.value }));
  return <Animated.View style={style}>{children}</Animated.View>;
}

/** processing 徽章旋转（web Loader2 animate-spin 的 RN 对应物，替代原生 ActivityIndicator）。
 *  页面隐藏时停帧，同 Pulse。 */
function Spin({ children }: { children: ReactNode }) {
  const pageActive = usePageActive();
  const r = useSharedValue(0);
  useEffect(() => {
    if (!pageActive) return;
    r.value = withRepeat(withTiming(360, { duration: 800, easing: Easing.linear }), -1, false);
    return () => {
      cancelAnimation(r);
      r.value = 0;
    };
  }, [r, pageActive]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${r.value}deg` }] }));
  return <Animated.View style={style}>{children}</Animated.View>;
}

/** 稳定的 keyExtractor（模块级,避免每 render 新建身份 → 破 SectionList 优化）。 */
const taskKey = (e: VisibleCardEntry) => `${e.runId}-${e.card.id}`;

const Row = memo(function Row({
  entry,
  onOpenChat,
  onOpenDetail,
}: {
  entry: VisibleCardEntry;
  onOpenChat: (card: IntentCard) => void;
  onOpenDetail: (entry: VisibleCardEntry) => void;
}) {
  const { t } = useTranslation("tasks");
  const card = entry.card;
  // 壳级共享集合（web CardTimeline:119-134 逐字）：resolved = 本地
  // dismissed/done（乐观 + mount-restore），立即划线；execution 态服务端
  // runStatus 优先，乐观 processingIds 只桥接 send → run-row 的空窗。
  const { dismissedIds, confirmedIds, processingIds, doneIds, chattedIds } =
    useCardActionsContext();
  const isDismissed = dismissedIds.has(card.id);
  const isConfirmed = confirmedIds.has(card.id);
  const isProcessing = processingIds.has(card.id);
  const isDone = doneIds.has(card.id);
  const isChatted = chattedIds.has(card.id);
  const isResolved = isDismissed || isDone;
  const runUi = isResolved
    ? "normal"
    : deriveCardUiStatus({
        runStatus: entry.runStatus,
        latestOutcome: entry.latestOutcome,
        optimisticProcessing: isProcessing,
        chatted: isChatted,
      });
  const reminder = isReminderCard(card);
  const actionCount = card.secondaryActions?.length ?? 0;
  const CatIcon = categoryIcon(card);
  // previewText 链（web CardTimeline:135-160 逐字；snooze 归入 dismissedIds →
  // "Dismissed"，web 无独立 Snoozed 文案）。
  const previewText = isDone
    ? t("preview.completed")
    : isDismissed
    ? t("preview.dismissed")
    : runUi === "processing"
    ? t("preview.processing")
    : runUi === "needs_input"
    ? t("preview.needsInput")
    : runUi === "ready"
    ? t("preview.ready")
    : runUi === "failed"
    ? t("preview.failed")
    : isChatted
    ? t("preview.inConversation")
    : isConfirmed
    ? t("preview.confirmed")
    : reminder
    // A reminder has no operations —— 显示 nudge 正文，不显示 "2 operations · Done"
    // （web 同注释）。
    ? card.summary
    : card.primaryAction
    ? t("preview.operationsSummary", { count: actionCount + 1, action: card.primaryAction.label })
    : (card.sourceApps ?? [])
        .map((s) => {
          // 对齐 web sourceAppDisplay：普通词走 i18n（card:sourceApp.*），品牌词
          // （无 labelKey）保留英文 brand 名。
          const meta = sourceAppMeta(s);
          return meta.labelKey ? i18n.t(`card:sourceApp.${meta.labelKey}`) : meta.label;
        })
        .join(" · ");

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={card.title}
      // web CardTimeline:166-170：活跃 run 或聊过 → 回到 card chat；否则开详情。
      onPress={() => (runUi !== "normal" || isChatted ? onOpenChat(card) : onOpenDetail(entry))}
      style={({ pressed }) => (pressed ? styles.pressed : null)}
    >
      <GlassCard className="mb-2 px-3.5 py-4">
        {/* web CardTimeline:172 —— 图标 items-center 对齐整列；标题行 + 预览行
            嵌在图标右侧的文字列里，预览第二行因此缩进对齐标题（而非顶到最左）。 */}
        <View style={styles.row}>
          <CatIcon size={16} color="rgba(29,33,48,0.5)" />
          <View style={styles.col}>
            <View style={styles.titleRow}>
              <Text
                className={isResolved ? "flex-1 text-[13px] text-foreground/35 line-through" : "flex-1 text-[13px] text-foreground"}
                style={{ fontFamily: "Inter_500Medium", lineHeight: 18 }}
                numberOfLines={2}
              >
                {card.title}
              </Text>
              <View style={styles.badge}>
                {isResolved ? (
                  <CheckCircle2 size={15} color="rgba(34,197,94,0.6)" />
                ) : runUi === "processing" ? (
                  <Spin>
                    <Loader2 size={15} color="#f59e0b" />
                  </Spin>
                ) : runUi === "needs_input" ? (
                  <Pulse>
                    <CircleAlert size={15} color="#f59e0b" />
                  </Pulse>
                ) : runUi === "ready" ? (
                  <CheckCircle2 size={15} color="#22c55e" />
                ) : runUi === "failed" ? (
                  <XCircle size={15} color="#f43f5e" />
                ) : (
                  <Circle size={15} color="#fb7185" fill="#fb7185" />
                )}
              </View>
            </View>
            <View style={styles.bottomRow}>
              <Text className="flex-1 text-[11px] text-foreground/40" numberOfLines={1} style={{ fontFamily: "Inter_400Regular" }}>
                {previewText}
              </Text>
              <Text className="text-[10px] text-muted-foreground" style={{ fontFamily: "Inter_400Regular" }}>
                {formatTime(entry.runCompletedAt)}
              </Text>
            </View>
          </View>
        </View>
      </GlassCard>
    </Pressable>
  );
});

export default function TasksScreen({
  headerProps,
  onOpenChat,
}: {
  headerProps: HeaderProps;
  onOpenChat: (card: IntentCard, bootstrap: string) => void;
}) {
  const { t } = useTranslation("tasks");
  const { cards, loading } = useCardsQuery();
  const [detail, setDetail] = useState<VisibleCardEntry | null>(null);

  // 壳级单实例动作（CardActionsProvider）：dismiss/done 立即翻本地集合 →
  // 行内即刻划线（web CardTimeline 同语义），且与 NOW 球面同步退场。
  const cardActions = useCardActionsContext();

  // sections 用 useMemo（cards 不变时不重算分组、稳定 sections 身份）；配合 memo(Row) +
  // 稳定回调,轮询/详情开关等无关重渲不再让整表 re-reconcile（P6）。
  const sections = useMemo(() => {
    const groups = new Map<string, VisibleCardEntry[]>();
    for (const entry of cards) {
      const label = formatDate(entry.runCompletedAt);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label)!.push(entry);
    }
    return [...groups.entries()].map(([title, data]) => ({ title, data }));
  }, [cards]);

  // 稳定 onOpenChat 包装 → memo(Row) 生效（setDetail 本就稳定）。
  const openChat = useCallback((card: IntentCard) => onOpenChat(card, ""), [onOpenChat]);

  return (
    <View className="flex-1">
      <PageHeader title={t("header.title")} subtitle={t("header.subtitle")} {...headerProps} />
      <SectionList
        className="flex-1 px-4"
        sections={sections}
        keyExtractor={taskKey}
        stickySectionHeadersEnabled={false}
        // 窗口化（P6）：长列表只渲染视口附近的行。removeClippedSubviews 有白格风险、
        // 真机没法自测,先不加——这几项已够。
        windowSize={7}
        maxToRenderPerBatch={8}
        initialNumToRender={10}
        updateCellsBatchingPeriod={50}
        renderSectionHeader={({ section }) => (
          <Text
            // web CardTimeline:103 —— text-xs(12) font-semibold uppercase tracking-wider(0.05em≈0.6px) mb-3
            className="mb-3 mt-3 text-[12px] tracking-[0.6px] text-muted-foreground"
            style={{ fontFamily: "Inter_600SemiBold" }}
          >
            {section.title.toUpperCase()}
          </Text>
        )}
        renderItem={({ item }) => (
          <Row
            entry={item}
            onOpenChat={openChat}
            onOpenDetail={setDetail}
          />
        )}
        contentContainerClassName="pb-10"
        ListEmptyComponent={
          loading ? (
            // web CardTimeline:94 —— Loader2 spin + "Loading history..."（foreground/40, py-8 gap-2）
            <View className="flex-row items-center justify-center py-8 gap-2">
              <Spin>
                <Loader2 size={16} color="rgba(29,33,48,0.4)" />
              </Spin>
              <Text className="text-[13px] text-foreground/40" style={{ fontFamily: "Inter_400Regular" }}>
                {t("loadingHistory")}
              </Text>
            </View>
          ) : (
            // web CardTimeline:214 —— Sparkles 套玻璃圆环（glass-card p-4 rounded-full）, gap-3
            <View className="items-center py-16 gap-3">
              <GlassCard radius={40} className="p-4">
                <Sparkles size={28} color="rgba(29,33,48,0.4)" strokeWidth={1.5} />
              </GlassCard>
              <Text className="text-[15px] text-foreground/60" style={{ fontFamily: "Inter_600SemiBold", letterSpacing: -0.3 }}>
                {t("empty.title")}
              </Text>
              <Text className="max-w-[260px] text-center text-[13px] leading-5 text-foreground/40" style={{ fontFamily: "Inter_400Regular" }}>
                {t("empty.body")}
              </Text>
            </View>
          )
        }
      />
      <CardDetailSheet
        entry={detail}
        onClose={() => setDetail(null)}
        onDismiss={(e) => {
          cardActions.dismiss(e.card);
          setDetail(null);
        }}
        onComplete={(e) => {
          cardActions.complete(e.card);
          setDetail(null);
        }}
        onApprove={(e) => {
          void cardActions.confirm(e.card);
          setDetail(null);
        }}
        onChat={(e) => {
          cardActions.chat(e.card);
          setDetail(null);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // web CardTimeline:172 —— icon items-center 对齐整列；col 承载标题行+预览行。
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  col: { flex: 1, minWidth: 0 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  badge: { width: 18, height: 18, alignItems: "center", justifyContent: "center" },
  bottomRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 6 },
  pressed: { transform: [{ scale: 0.98 }] },
});
