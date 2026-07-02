/**
 * TASKS 页——web CardTimeline 的 RN 对应物：日期分组（Today/Yesterday/Mon d）
 * + 玻璃行（分类图标 + 标题 + 状态环 + previewText + 时间）。状态语义来自 core
 * deriveCardUiStatus（服务端 runStatus 真相源；RN 无 web 的乐观 id 集，resolved
 * 由 latestOutcome 派生——同一服务端语义）。
 *
 * 点行分流（对齐 web CardTimeline:166）：活跃卡（processing/needs_input/ready/
 * failed）→ card chat；新卡（normal）→ 详情面板（confirm/steer/snooze/dismiss），
 * 复用 NOW 同款 CardDetailSheet + useCardActions（动作两屏唯一真源）。
 */
import { useEffect, useState, type ReactNode } from "react";
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

import PageHeader from "../components/app/PageHeader";
import { usePageActive } from "../components/app/KeepAlivePage";
import CardDetailSheet from "../components/now/CardDetailSheet";
import { CATEGORIES } from "../components/now/SphereCards";
import { GlassCard } from "../ui/GlassCard";
import { getToolkitIcon } from "../lib/toolkit-icons";
import { useCardActions } from "../hooks/useCardActions";
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
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
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

function Row({
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
  const resolved =
    entry.latestOutcome === "dismiss"
    || entry.latestOutcome === "complete"
    || entry.latestOutcome === "snooze";
  const runUi = resolved
    ? "normal"
    : deriveCardUiStatus({
        runStatus: entry.runStatus,
        latestOutcome: entry.latestOutcome,
        optimisticProcessing: false,
        chatted: false,
      });
  const reminder = isReminderCard(card);
  const actionCount = card.secondaryActions?.length ?? 0;
  const CatIcon = categoryIcon(card);
  const previewText =
    entry.latestOutcome === "complete"
      ? t("preview.completed")
      : entry.latestOutcome === "dismiss"
      ? t("preview.dismissed")
      : entry.latestOutcome === "snooze"
      ? "Snoozed"
      : runUi === "processing"
      ? t("preview.processing")
      : runUi === "needs_input"
      ? t("preview.needsInput")
      : runUi === "ready"
      ? t("preview.ready")
      : runUi === "failed"
      ? t("preview.failed")
      : reminder
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
      onPress={() => (runUi !== "normal" ? onOpenChat(card) : onOpenDetail(entry))}
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
                className={resolved ? "flex-1 text-[13px] text-foreground/35 line-through" : "flex-1 text-[13px] text-foreground"}
                style={{ fontFamily: "Inter_500Medium", lineHeight: 18 }}
                numberOfLines={2}
              >
                {card.title}
              </Text>
              <View style={styles.badge}>
                {resolved ? (
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
}

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

  // 历史列表是服务端真相视图：dismiss/snooze 不立即移除行，靠下次轮询把
  // latestOutcome 翻成 resolved（strikethrough）。所以 onHide 传 noop。
  const actions = useCardActions({
    onOpenChat,
    onHide: () => {},
    onClose: () => setDetail(null),
  });

  const groups = new Map<string, VisibleCardEntry[]>();
  for (const entry of cards) {
    const label = formatDate(entry.runCompletedAt);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(entry);
  }
  const sections = [...groups.entries()].map(([title, data]) => ({ title, data }));

  return (
    <View className="flex-1">
      <PageHeader title={t("header.title")} subtitle={t("header.subtitle")} {...headerProps} />
      <SectionList
        className="flex-1 px-4"
        sections={sections}
        keyExtractor={(e) => `${e.runId}-${e.card.id}`}
        stickySectionHeadersEnabled={false}
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
            onOpenChat={(card) => onOpenChat(card, "")}
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
        onDismiss={actions.dismiss}
        onComplete={actions.complete}
        onApprove={actions.confirm}
        onChat={actions.chat}
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
