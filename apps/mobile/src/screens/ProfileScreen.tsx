/**
 * PROFILE 页——web `MirrorMobile.tsx`（移动布局 shell）+ `ui-web/profile/mirror.tsx`
 * （panel 层）的 RN 对应物。
 *
 * 结构对齐 web：页头 → [error 卡] → Identity/Goals 胶囊 switcher（inline
 * blur 玻璃 + 黑 pill）→ 横向 swipe pager（Identity pane = IdentitySummaryCard
 * + Profile/Memory 双钮 + 折叠组/Memory 面板；Goals pane = GoalsGrid）→ goal
 * 详情底部抽屉（GoalDetailSheet）。
 *
 * 数据 = @pin-ai/state 的 useProfileSnapshot / useProfileMemories（与 web 同源，
 * memory 5 条/页 load-more 累积）。纯派生 helper 在 ./mirror-helpers（mirror.tsx
 * 的 RN 复制版）。pager 用 RN 标准 ScrollView pagingEnabled（原生分页物理，替代
 * web framer 手写 commit 阈值 0.3/300px·s——架构差异，行为等价：跟手横滑 + 松手
 * snap，纵向滚动交给 pane 内 ScrollView）。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Image,
  LayoutAnimation,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  FadeInUp,
  interpolateColor,
  runOnJS,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { Goal, Memory, ProfileSnapshot } from "@pin-ai/core";
import { profileKeys, profileMemoriesKeys, useProfileMemories, useProfileSnapshot } from "@pin-ai/state";
import { useQueryClient } from "@tanstack/react-query";

import { GlassCard } from "../ui/GlassCard";
import { usePageActive } from "../components/app/KeepAlivePage";
import PageHeader from "../components/app/PageHeader";
import GoalDetailSheet from "../components/profile/GoalDetailSheet";
import {
  basketMeta,
  canonicalBasketGoals,
  formatClockTime,
  formatValue,
  getVisualMeta,
  groupMemoriesByDay,
  prettyFieldKey,
  priorityToStatus,
  profileSummaryText,
  statusLabel,
  PROFILE_GROUP_META,
  type ProfileGroupKey,
  type VisualStatus,
} from "../components/profile/mirror-helpers";
import { EM_TIGHT, tracking } from "../ui/typography";
import type { HeaderProps } from "./AmbientScreen";

const FG = "29,33,48"; // --foreground ≈ rgb(29,33,48)
const BACKGROUND = "#f2f4f8"; // --background hsl(220 30% 96%)
const MUTED_FG = "rgb(115,123,140)"; // --muted-foreground hsl(220 10% 50%)
const ROSE_500 = "#f43f5e";

// dev `.glass-card` recipe（native-power-save 砍 blur 后）——与 ui/GlassCard 同一
// 配方；WorkbenchTabButton / goal 卡需要黑底 underlay / 圆角裁切，GlassCard 组件
// 的层次做不到，这里自组同款层。
const GLASS_GRADIENT = ["rgba(255,255,255,0.55)", "rgba(255,255,255,0.25)"] as const;
const GLASS_BORDER = "rgba(255,255,255,0.45)";
const GLASS_SHADOW = "0 4px 16px rgba(0,0,0,0.04), 0 1px 4px rgba(0,0,0,0.02)";

// Identity / Goals 两个 pane 并排，横向 swipe 切换（web TOP_TABS）。
const TOP_TABS = ["identity", "goals"] as const;
type TopTab = (typeof TOP_TABS)[number];

/** web statusBarColor：bg-{emerald,rose,amber}-400/50。 */
const STATUS_BAR_COLOR: Record<VisualStatus, string> = {
  Normal: "rgba(52,211,153,0.5)",
  Alert: "rgba(251,113,133,0.5)",
  Watch: "rgba(251,191,36,0.5)",
};

/** web grid statusPillColor：bg-{emerald,rose,amber}-500/10 + text-{emerald,rose,amber}-700。 */
const GRID_PILL: Record<VisualStatus, { bg: string; text: string }> = {
  Normal: { bg: "rgba(16,185,129,0.1)", text: "#047857" },
  Alert: { bg: "rgba(244,63,94,0.1)", text: "#be123c" },
  Watch: { bg: "rgba(245,158,11,0.1)", text: "#b45309" },
};

/** web sectionMotion：opacity 0→1 / y 12→0 / 0.24s。 */
const sectionEntering = FadeInUp.duration(240).withInitialValues({
  opacity: 0,
  transform: [{ translateY: 12 }],
});

/** 旋转（web Loader2 animate-spin）。 */
function Spin({ children }: { children: ReactNode }) {
  const r = useSharedValue(0);
  useEffect(() => {
    r.value = withRepeat(withTiming(360, { duration: 800, easing: Easing.linear }), -1, false);
  }, [r]);
  const st = useAnimatedStyle(() => ({ transform: [{ rotate: `${r.value}deg` }] }));
  return <Animated.View style={st}>{children}</Animated.View>;
}

/** pill switcher 文字——颜色由 pager 滚动进度实时驱动（UI 线程），与滑动黑 thumb 同步渐变。 */
function PillLabel({
  index,
  text,
  scrollX,
  pageWidth,
}: {
  index: number;
  text: string;
  scrollX: SharedValue<number>;
  pageWidth: number;
}) {
  const st = useAnimatedStyle(() => {
    const p = pageWidth > 0 ? scrollX.value / pageWidth : 0;
    const activeAmount = 1 - Math.min(1, Math.abs(p - index));
    return { color: interpolateColor(activeAmount, [0, 1], [`rgba(${FG},0.55)`, BACKGROUND]) };
  }, [pageWidth, index]);
  return <Animated.Text style={[styles.pillText, st]}>{text}</Animated.Text>;
}

/** web EmptyState：虚线框空态。⚠️ RN iOS 圆角+dashed 可能渲染成实线（已知限制），真机确认。 */
function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <View style={styles.emptyBox}>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyDesc}>{description}</Text>
    </View>
  );
}

/** web IdentitySummaryCard——label + name + summary（有意无头像：真实 profile 无 per-user 头像）。 */
function IdentitySummaryCard({ profile }: { profile: ProfileSnapshot["profile"] }) {
  const { t } = useTranslation("profile");
  return (
    <Animated.View entering={sectionEntering}>
      <GlassCard style={styles.identityCard}>
        <Text style={styles.idLabel}>{t("goalsView.identityLabel")}</Text>
        <Text style={styles.idName}>{profile?.display_name?.trim() || t("goalsView.unnamedUser")}</Text>
        <Text style={styles.idSummary} numberOfLines={6}>
          {profileSummaryText(profile)}
        </Text>
      </GlassCard>
    </Animated.View>
  );
}

/** web WorkbenchTabButton——Profile/Memory 分段钮。active = glass-card 叠 bg-foreground
 *  （白渐变合成在黑底上，web 同一合成结果），文字换 background 色。切换用 150ms
 *  过渡（web transition-all 默认时长），黑底 opacity + 文字 interpolateColor。 */
function WorkbenchTabButton({
  active,
  label,
  value,
  onPress,
}: {
  active: boolean;
  label: string;
  value: string;
  onPress: () => void;
}) {
  const progress = useDerivedValue(() => withTiming(active ? 1 : 0, { duration: 150 }), [active]);
  const blackStyle = useAnimatedStyle(() => ({ opacity: progress.value }));
  const labelStyle = useAnimatedStyle(() => ({
    color: interpolateColor(progress.value, [0, 1], [`rgba(${FG},0.35)`, "rgba(242,244,248,0.6)"]),
  }));
  const valueStyle = useAnimatedStyle(() => ({
    color: interpolateColor(progress.value, [0, 1], ["#1d2130", BACKGROUND]),
  }));
  return (
    <View style={styles.flex1}>
      <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: active }}>
        <View style={styles.wtbShadow}>
          <View style={styles.wtbClip}>
            <Animated.View style={[StyleSheet.absoluteFill, styles.wtbBlack, blackStyle]} />
            <LinearGradient
              colors={GLASS_GRADIENT}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={StyleSheet.absoluteFill}
            />
            <View style={styles.wtbBorder} pointerEvents="none" />
            <View style={styles.wtbBody}>
              <Animated.Text style={[styles.wtbLabel, labelStyle]}>{label.toUpperCase()}</Animated.Text>
              <Animated.Text style={[styles.wtbValue, valueStyle]}>{value}</Animated.Text>
            </View>
          </View>
        </View>
      </Pressable>
    </View>
  );
}

/** web ProfileGroupCard——单个折叠组（Facts/Preferences/Constraints）。 */
function ProfileGroupCard({
  groupKey,
  title,
  description,
  emptyTitle,
  values,
  expanded,
  onToggle,
}: {
  groupKey: ProfileGroupKey;
  title: string;
  description: string;
  emptyTitle: string;
  values: Record<string, unknown>;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation("profile");
  const entries = Object.entries(values);
  return (
    <GlassCard key={groupKey}>
      <Pressable onPress={onToggle} accessibilityRole="button" accessibilityState={{ expanded }}>
        <View style={styles.groupHeader}>
          <View style={styles.flex1}>
            <View style={styles.groupTitleRow}>
              <Text style={styles.groupTitle}>{title}</Text>
              <View style={styles.countPill}>
                <Text style={styles.countPillText}>{entries.length}</Text>
              </View>
            </View>
            <Text style={styles.groupDesc}>{description}</Text>
          </View>
          <ChevronDown
            size={14}
            strokeWidth={1.5}
            color={`rgba(${FG},0.25)`}
            style={{ transform: [{ rotate: expanded ? "180deg" : "0deg" }] }}
          />
        </View>
      </Pressable>
      {expanded ? (
        <View style={styles.groupBody}>
          {entries.length === 0 ? (
            <EmptyState title={emptyTitle} description={t("goalsView.groupEmptyDescription")} />
          ) : (
            <View style={styles.entriesWrap}>
              {entries.map(([key, value]) => (
                <View key={key} style={styles.entryRow}>
                  <Text style={styles.entryKey}>{prettyFieldKey(key)}</Text>
                  <Text style={styles.entryValue}>{formatValue(value)}</Text>
                </View>
              ))}
            </View>
          )}
        </View>
      ) : null}
    </GlassCard>
  );
}

/** web ProfilePanel——标题区 + 三个折叠组。文案经 i18n goalsView.mirror / profileGroups.*（同 web）。 */
function ProfilePanel({
  profile,
  openGroups,
  onToggleGroup,
}: {
  profile: ProfileSnapshot["profile"];
  openGroups: Record<ProfileGroupKey, boolean>;
  onToggleGroup: (group: ProfileGroupKey) => void;
}) {
  const { t } = useTranslation("profile");
  return (
    <View>
      <View style={styles.panelHeader}>
        <Text style={styles.panelTitle}>{t("goalsView.mirror.title")}</Text>
        <Text style={styles.panelDesc}>{t("goalsView.mirror.description")}</Text>
      </View>
      <View style={styles.groupsWrap}>
        {PROFILE_GROUP_META.map((group) => (
          <ProfileGroupCard
            key={group.key}
            groupKey={group.key}
            title={t(`goalsView.profileGroups.${group.key}.title`)}
            description={t(`goalsView.profileGroups.${group.key}.description`)}
            emptyTitle={t(`goalsView.profileGroups.${group.key}.emptyTitle`)}
            values={(profile?.[group.key] ?? {}) as Record<string, unknown>}
            expanded={openGroups[group.key]}
            onToggle={() => onToggleGroup(group.key)}
          />
        ))}
      </View>
    </View>
  );
}

/** web MemoryListItem——正文在上、归因行在下。 */
function MemoryListItem({ memory }: { memory: Memory }) {
  const { t } = useTranslation("profile");
  const when = memory.occurred_at ?? memory.created_at;
  const time = formatClockTime(when);
  return (
    <View>
      <Text style={styles.memText}>{memory.text}</Text>
      <Text style={styles.memAttr}>
        {t("goalsView.memory.inferredFrom", { source: memory.source })}
        {time ? ` · ${time}` : ""}
      </Text>
    </View>
  );
}

/** web MemoryPanel——按天分组 + 分页 footer（shown of total / Load more）。 */
function MemoryPanel({
  memories,
  total,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  memories: Memory[];
  total: number;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const { t } = useTranslation(["profile", "common"]);
  const groups = groupMemoriesByDay(memories);
  const disabled = !hasMore || loadingMore;
  return (
    <View>
      <View style={styles.panelHeader}>
        <Text style={styles.panelTitle}>{t("goalsView.memory.title")}</Text>
        <Text style={styles.panelDesc}>{t("goalsView.memory.description")}</Text>
      </View>
      <View style={styles.memGroups}>
        {memories.length === 0 ? (
          <EmptyState
            title={t("goalsView.memory.emptyTitle")}
            description={t("goalsView.memory.emptyDescription")}
          />
        ) : (
          groups.map((group) => (
            <View key={group.key}>
              <View style={styles.memGroupHeader}>
                <Text style={styles.memGroupLabel}>{group.label}</Text>
                <Text style={styles.memGroupCount}>{group.items.length}</Text>
              </View>
              <View style={styles.memItems}>
                {group.items.map((memory) => (
                  <MemoryListItem key={memory.id} memory={memory} />
                ))}
              </View>
            </View>
          ))
        )}
      </View>
      <View style={styles.memFooter}>
        <Text style={styles.memCount}>
          {total === 0
            ? t("goalsView.memory.countZero")
            : t("goalsView.memory.countOfTotal", { shown: memories.length, total })}
        </Text>
        <Pressable onPress={onLoadMore} disabled={disabled} accessibilityRole="button">
          <View style={[styles.loadMoreBtn, disabled && styles.loadMoreDisabled]}>
            {loadingMore ? (
              <>
                <Spin>
                  <Loader2 size={12} color={`rgba(${FG},0.55)`} />
                </Spin>
                <Text style={styles.loadMoreText}>{t("common:status.loading")}</Text>
              </>
            ) : (
              <Text style={styles.loadMoreText}>
                {hasMore ? t("goalsView.memory.loadMore") : t("goalsView.memory.endOfList")}
              </Text>
            )}
          </View>
        </Pressable>
      </View>
    </View>
  );
}

/** web GoalsGrid 里的单张 goal 卡（2 列网格）。 */
function GoalCard({ goal, width, onOpen }: { goal: Goal; width: number; onOpen: (key: string) => void }) {
  const visual = getVisualMeta(goal.key);
  const basket = basketMeta(goal.key);
  const status = priorityToStatus(goal.priority);
  const Icon = basket.icon;
  const pill = GRID_PILL[status];
  // web：Growth 配图 h-[62%]，其余 h-[85%]（图区 h-24=96）。web 比 basket.label
  // 是因其 label 恒英文；RN label 已本地化，改比语言无关的 iconKey。
  const imgHeight = basket.iconKey === "growth" ? 96 * 0.62 : 96 * 0.85;

  return (
    <Pressable onPress={() => onOpen(goal.key)} accessibilityRole="button">
      {({ pressed }) => (
        <View style={[styles.goalShadow, { width }, pressed && styles.goalPressed]}>
          <View style={styles.goalClip}>
            <LinearGradient
              colors={GLASS_GRADIENT}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={StyleSheet.absoluteFill}
            />
            <View style={styles.goalImageArea}>
              <Image
                source={visual.image}
                style={{ width: "100%", height: imgHeight }}
                resizeMode="contain"
              />
            </View>
            <View style={styles.goalBody}>
              <View style={styles.goalTitleRow}>
                <Icon size={16} color="#1d2130" />
                <Text style={styles.goalTitle}>{basket.label}</Text>
              </View>
              <View style={styles.goalBar}>
                <View
                  style={[
                    styles.goalBarFill,
                    { width: `${visual.pct}%`, backgroundColor: STATUS_BAR_COLOR[status] },
                  ]}
                />
              </View>
              <View style={styles.goalPctRow}>
                <Text style={styles.goalPct}>{visual.pct}%</Text>
                <View style={[styles.goalPill, { backgroundColor: pill.bg }]}>
                  <Text style={[styles.goalPillText, { color: pill.text }]}>{statusLabel(status)}</Text>
                </View>
              </View>
              <View style={styles.goalSummaryRow}>
                <Text style={styles.goalSummary} numberOfLines={2}>
                  {goal.summary || goal.title}
                </Text>
                <ChevronRight size={14} color={`rgba(${FG},0.3)`} />
              </View>
            </View>
            <View style={styles.goalBorder} pointerEvents="none" />
          </View>
        </View>
      )}
    </Pressable>
  );
}

/** web GoalsGrid——Goals pane 的 2 列网格 section。goals 已经 canonicalBasketGoals
 *  归一化为固定 6 槽（空态分支不可达，删）。 */
function GoalsGrid({ goals, onOpen }: { goals: Goal[]; onOpen: (key: string) => void }) {
  const { t } = useTranslation("profile");
  const [gridWidth, setGridWidth] = useState(0);
  const cardWidth = gridWidth > 0 ? (gridWidth - 12) / 2 : 0;
  return (
    <Animated.View entering={sectionEntering}>
      <GlassCard style={styles.panelSection}>
        <View style={styles.panelHeader}>
          <Text style={styles.panelTitle}>{t("goalsView.goals.title")}</Text>
          <Text style={styles.panelDesc}>{t("goalsView.goals.description")}</Text>
        </View>
        <View
          style={styles.goalsGrid}
          onLayout={(e: LayoutChangeEvent) => setGridWidth(e.nativeEvent.layout.width)}
        >
          {cardWidth > 0
            ? goals.map((goal) => (
                <GoalCard key={goal.key} goal={goal} width={cardWidth} onOpen={onOpen} />
              ))
            : null}
        </View>
      </GlassCard>
    </Animated.View>
  );
}

export default function ProfileScreen({ headerProps }: { headerProps: HeaderProps }) {
  const { t } = useTranslation("profile");
  const { profile, activeGoals, loading, error } = useProfileSnapshot();
  const memory = useProfileMemories();

  // KeepAlive 常驻不卸载 → 复刻 dev「每次进 tab 重挂载必 refetch」语义：
  // 切回本页时失效 profile/memories（active query 立即后台重拉，SWR 不闪 loading）。
  const pageActive = usePageActive();
  const queryClient = useQueryClient();
  const wasActiveRef = useRef(pageActive);
  useEffect(() => {
    if (pageActive && !wasActiveRef.current) {
      void queryClient.invalidateQueries({ queryKey: profileKeys.all });
      void queryClient.invalidateQueries({ queryKey: profileMemoriesKeys.all });
    }
    wasActiveRef.current = pageActive;
  }, [pageActive, queryClient]);

  const [activeTab, setActiveTab] = useState<TopTab>("identity");
  const [identitySubTab, setIdentitySubTab] = useState<"profile" | "memory">("profile");
  const [openGroups, setOpenGroups] = useState<Record<ProfileGroupKey, boolean>>({
    facts: false,
    preferences: false,
    constraints: false,
    metadata: false,
  });
  const [expandedGoal, setExpandedGoal] = useState<string | null>(null);

  const pagerRef = useAnimatedRef<Animated.ScrollView>();
  // pane 要显式宽高：横向 ScrollView 里的子 View 无界时，内嵌竖向 ScrollView 不滚。
  const [pagerSize, setPagerSize] = useState({ w: 0, h: 0 });
  const pagerWidth = pagerSize.w;
  // pill 玻璃条实测宽 → 黑 thumb 宽（两侧 p-1 + 中间 gap-1 = 12）。
  const [pillWidth, setPillWidth] = useState(0);
  const thumbWidth = pillWidth > 0 ? (pillWidth - 12) / 2 : 0;
  // pager 滚动进度（UI 线程共享值）：驱动 pill thumb 位移 + 文字色渐变。
  const scrollX = useSharedValue(0);

  const toggleGroup = (group: ProfileGroupKey) => {
    // web AnimatePresence height auto 展开/收起 → RN LayoutAnimation（既定模式）。
    LayoutAnimation.configureNext(LayoutAnimation.create(200, "easeInEaseOut", "opacity"));
    setOpenGroups((prev) => ({ ...prev, [group]: !prev[group] }));
  };

  // Goals 网格 = 6 个规范 basket 槽位（prod 种子展示效果；见 canonicalBasketGoals 注释）。
  const displayGoals = canonicalBasketGoals(activeGoals);
  const selectedGoal = expandedGoal
    ? displayGoals.find((goal) => goal.key === expandedGoal) ?? null
    : null;

  // pill 点击：滚 pager 到目标 pane（web animate trackX spring）；thumb/文字由 scrollX 跟随。
  const selectTab = (tab: TopTab) => {
    setActiveTab(tab);
    pagerRef.current?.scrollTo({ x: TOP_TABS.indexOf(tab) * pagerWidth, animated: true });
  };

  // swipe 松手 snap 完成 → 提交 activeTab（仅逻辑/a11y；pill 视觉全程 scrollX 驱动，不等提交）。
  const commitTab = useCallback((idx: number) => {
    setActiveTab(TOP_TABS[Math.min(TOP_TABS.length - 1, Math.max(0, idx))]);
  }, []);

  const pagerScrollHandler = useAnimatedScrollHandler(
    {
      onScroll: (e) => {
        scrollX.value = e.contentOffset.x;
      },
      onMomentumEnd: (e) => {
        const idx = pagerWidth > 0 ? Math.round(e.contentOffset.x / pagerWidth) : 0;
        runOnJS(commitTab)(idx);
      },
    },
    [pagerWidth, commitTab],
  );

  // pill 黑 thumb：位移 = 滚动进度 ×（thumb 宽 + gap 4），全程 UI 线程、与 pane 同帧。
  const thumbStyle = useAnimatedStyle(() => {
    const p = pagerWidth > 0 ? Math.min(1, Math.max(0, scrollX.value / pagerWidth)) : 0;
    return { transform: [{ translateX: p * (thumbWidth + 4) }] };
  }, [pagerWidth, thumbWidth]);

  // Profile/Memory 子 tab：LayoutAnimation 交叉淡入 + 高度过渡（替换硬切）。
  const selectSubTab = (tab: "profile" | "memory") => {
    if (tab === identitySubTab) return;
    LayoutAnimation.configureNext(LayoutAnimation.create(200, "easeInEaseOut", "opacity"));
    setIdentitySubTab(tab);
  };

  // 视口（重）量时把 pager 对回 active pane（web pagerWidth effect）。
  useEffect(() => {
    if (pagerWidth > 0) {
      pagerRef.current?.scrollTo({ x: TOP_TABS.indexOf(activeTab) * pagerWidth, animated: false });
    }
    // 只跟宽度：tab 切换的滚动由 selectTab / 手势自己完成。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pagerWidth]);

  return (
    <View style={styles.flex1}>
      <PageHeader
        title={
          // web MirrorMobile h1：text-2xl(24) / font-semibold / tracking-tight(-0.025em) / 默认 lh 32。
          <Text
            style={{
              fontSize: 24,
              fontFamily: "Inter_600SemiBold",
              letterSpacing: tracking(24, EM_TIGHT),
              lineHeight: 32,
              color: "#1d2130",
            }}
          >
            {t("goalsView.title")}
          </Text>
        }
        subtitle={
          // web 副标题：mt-0.5 text-xs(12) text-muted-foreground。
          <Text
            style={{
              marginTop: 2,
              fontSize: 12,
              lineHeight: 16,
              fontFamily: "Inter_400Regular",
              color: MUTED_FG,
            }}
          >
            {t("goalsView.subtitle")}
          </Text>
        }
        {...headerProps}
      />

      {loading ? (
        // web：Loader2 16 spin + bodySm foreground/40，py-14。
        <View style={styles.loadingRow}>
          <Spin>
            <Loader2 size={16} color={`rgba(${FG},0.4)`} />
          </Spin>
          <Text style={styles.loadingText}>{t("goalsView.loadingSnapshot")}</Text>
        </View>
      ) : (
        <View style={styles.content}>
          {error ? (
            <Animated.View entering={sectionEntering}>
              <GlassCard style={styles.errorCard}>
                <Text style={styles.errorTitle}>{t("goalsView.refreshError")}</Text>
                <Text style={styles.errorBody}>{error}</Text>
              </GlassCard>
            </Animated.View>
          ) : null}

          {/* Identity / Goals pill switcher（web inline 玻璃：blur(20) + 180° 白渐变 .7→.5 +
              white/50 边——inline style 不被 native-power-save 砍，dev 真机有 blur → BlurView）。
              黑 pill = 滑动 thumb，由 pager scrollX 实时驱动（行业标准 tab-pager 同步，
              替代「momentum 结束才切态」的滞后跳变）。 */}
          <View
            style={styles.pillWrap}
            onLayout={(e: LayoutChangeEvent) => setPillWidth(e.nativeEvent.layout.width)}
          >
            <BlurView intensity={35} tint="light" style={StyleSheet.absoluteFill} />
            <LinearGradient
              colors={["rgba(255,255,255,0.7)", "rgba(255,255,255,0.5)"]}
              start={{ x: 0, y: 0 }}
              end={{ x: 0, y: 1 }}
              style={StyleSheet.absoluteFill}
            />
            <View style={styles.pillBorder} pointerEvents="none" />
            {thumbWidth > 0 ? (
              <Animated.View style={[styles.pillThumb, { width: thumbWidth }, thumbStyle]} />
            ) : null}
            <View style={styles.pillRow}>
              {TOP_TABS.map((tab, index) => (
                <View key={tab} style={styles.flex1}>
                  <Pressable
                    onPress={() => selectTab(tab)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: activeTab === tab }}
                  >
                    <View style={styles.pillBtn}>
                      <PillLabel
                        index={index}
                        text={t(`goalsView.tabs.${tab}`)}
                        scrollX={scrollX}
                        pageWidth={pagerWidth}
                      />
                    </View>
                  </Pressable>
                </View>
              ))}
            </View>
          </View>

          {/* 横向 pager：两个 pane 并排，跟手横滑 + 原生 snap（web framer drag track） */}
          <View
            style={styles.pager}
            onLayout={(e: LayoutChangeEvent) =>
              setPagerSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })
            }
          >
            {/* Gesture.Native 把 pager 的原生横滑注册进 RNGH 仲裁：起手即激活、
                全局抽屉左滑让路（不注册的话抽屉 pan 会在 18px 处把翻页拦腰取消）。 */}
            <GestureDetector gesture={Gesture.Native()}>
              <Animated.ScrollView
                ref={pagerRef}
                horizontal
                pagingEnabled
                showsHorizontalScrollIndicator={false}
                onScroll={pagerScrollHandler}
                scrollEventThrottle={16}
              >
              {/* Identity pane */}
              <View style={{ width: pagerSize.w, height: pagerSize.h }}>
                <ScrollView
                  style={styles.flex1}
                  showsVerticalScrollIndicator={false}
                  contentContainerStyle={styles.paneContent}
                >
                  <IdentitySummaryCard profile={profile} />

                  {/* Profile / Memory sub-tab（移动端二选一）。切换 = LayoutAnimation
                      交叉淡入（selectSubTab），面板不再挂 entering（避免双动画打架）。 */}
                  <View style={styles.subTabRow}>
                    <WorkbenchTabButton
                      active={identitySubTab === "profile"}
                      label={t("goalsView.subTabs.profile")}
                      value={profile ? t("goalsView.subTabs.profile") : t("goalsView.subTabs.empty")}
                      onPress={() => selectSubTab("profile")}
                    />
                    <WorkbenchTabButton
                      active={identitySubTab === "memory"}
                      label={t("goalsView.subTabs.memory")}
                      value={String(memory.total)}
                      onPress={() => selectSubTab("memory")}
                    />
                  </View>

                  {identitySubTab === "profile" ? (
                    <GlassCard style={styles.panelSection}>
                      <ProfilePanel
                        profile={profile}
                        openGroups={openGroups}
                        onToggleGroup={toggleGroup}
                      />
                    </GlassCard>
                  ) : (
                    <GlassCard style={styles.panelSection}>
                      <MemoryPanel
                        memories={memory.memories}
                        total={memory.total}
                        hasMore={memory.hasMore}
                        loadingMore={memory.loadingMore}
                        onLoadMore={memory.loadMore}
                      />
                    </GlassCard>
                  )}
                </ScrollView>
              </View>

              {/* Goals pane */}
              <View style={{ width: pagerSize.w, height: pagerSize.h }}>
                <ScrollView
                  style={styles.flex1}
                  showsVerticalScrollIndicator={false}
                  contentContainerStyle={styles.paneContentGoals}
                >
                  <GoalsGrid goals={displayGoals} onOpen={setExpandedGoal} />
                </ScrollView>
              </View>
              </Animated.ScrollView>
            </GestureDetector>
          </View>
        </View>
      )}

      {/* 手机：goal 详情走底部 Drawer（web detailLayout="drawer" 强制） */}
      <GoalDetailSheet goal={selectedGoal} onClose={() => setExpandedGoal(null)} />
    </View>
  );
}

// RN 0.85 类型无 StyleSheet.absoluteFillObject → 手写四边定位（ui/GlassCard 同做法）。
const absoluteFill = { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 } as const;

const styles = StyleSheet.create({
  flex1: { flex: 1 },
  // 页头块 web mb-6(24)：PageHeader 自带 pb-2(8) → 内容区补 pt 16。
  content: { flex: 1, paddingHorizontal: 16, paddingTop: 16 },

  loadingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 56,
  },
  loadingText: { fontSize: 13, lineHeight: 19, fontFamily: "Inter_400Regular", color: `rgba(${FG},0.4)` },

  errorCard: { padding: 16, marginBottom: 16 },
  errorTitle: { fontSize: 14, lineHeight: 20, fontFamily: "Inter_500Medium", color: ROSE_500 },
  errorBody: { marginTop: 4, fontSize: 12, lineHeight: 20, fontFamily: "Inter_400Regular", color: `rgba(${FG},0.55)` },

  // pill switcher：p-1 rounded-full + 玻璃层
  pillWrap: { borderRadius: 999, overflow: "hidden" },
  pillBorder: {
    ...absoluteFill,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.5)",
  },
  pillRow: { flexDirection: "row", alignItems: "center", gap: 4, padding: 4 },
  pillBtn: { paddingVertical: 10, borderRadius: 999, alignItems: "center" },
  // 滑动黑 thumb（active 态视觉），位置由 pager scrollX 驱动。
  pillThumb: {
    position: "absolute",
    left: 4,
    top: 4,
    bottom: 4,
    borderRadius: 999,
    backgroundColor: "#1d2130",
  },
  pillText: { fontSize: 14, lineHeight: 20, fontFamily: "Inter_600SemiBold" },

  pager: { flex: 1, marginTop: 16 },
  // web pane：space-y-4(16) pb-2(8)
  paneContent: { gap: 16, paddingBottom: 8 },
  paneContentGoals: { paddingBottom: 8 },

  // IdentitySummaryCard：glass p-5(20)
  identityCard: { padding: 20 },
  idLabel: {
    fontSize: 11,
    lineHeight: 15,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 11 * 0.18,
    color: `rgba(${FG},0.45)`,
  },
  idName: {
    marginTop: 8,
    fontSize: 20,
    lineHeight: 28,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 20 * -0.025,
    color: "#1d2130",
  },
  idSummary: { marginTop: 8, fontSize: 13, lineHeight: 24, fontFamily: "Inter_400Regular", color: `rgba(${FG},0.65)` },

  // WorkbenchTabButton：grid gap-2.5(10)、glass p-4(16)
  subTabRow: { flexDirection: "row", gap: 10 },
  wtbShadow: { borderRadius: 24, boxShadow: GLASS_SHADOW },
  wtbClip: { borderRadius: 24, overflow: "hidden" },
  wtbBlack: { backgroundColor: "#1d2130" },
  wtbBorder: {
    ...absoluteFill,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: GLASS_BORDER,
    boxShadow: "inset 0 1px 1px rgba(255,255,255,0.6)",
  },
  wtbBody: { padding: 16 },
  wtbLabel: { fontSize: 10, lineHeight: 14, fontFamily: "Inter_400Regular", letterSpacing: 10 * 0.16 },
  wtbValue: { marginTop: 4, fontSize: 16, lineHeight: 24, fontFamily: "Inter_600SemiBold" },

  // panel section：glass-card-strong p-4（native 与 glass-card 同渲染）
  panelSection: { padding: 16 },
  panelHeader: { marginBottom: 12 },
  panelTitle: { fontSize: 14, lineHeight: 20, fontFamily: "Inter_600SemiBold", color: "#1d2130" },
  panelDesc: { marginTop: 4, fontSize: 11, lineHeight: 20, fontFamily: "Inter_400Regular", color: `rgba(${FG},0.42)` },

  // 折叠组
  groupsWrap: { gap: 10 },
  groupHeader: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  groupTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  groupTitle: { fontSize: 14, lineHeight: 20, fontFamily: "Inter_600SemiBold", color: "#1d2130" },
  countPill: {
    borderRadius: 999,
    backgroundColor: `rgba(${FG},0.05)`,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  countPillText: { fontSize: 10, lineHeight: 14, fontFamily: "Inter_500Medium", color: `rgba(${FG},0.45)` },
  groupDesc: { marginTop: 4, fontSize: 12, lineHeight: 20, fontFamily: "Inter_400Regular", color: `rgba(${FG},0.42)` },
  groupBody: {
    borderTopWidth: 1,
    borderTopColor: `rgba(${FG},0.08)`,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 16,
  },
  entriesWrap: { gap: 4 },
  entryRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "baseline",
    columnGap: 12,
    rowGap: 2,
    paddingVertical: 4,
  },
  entryKey: { fontSize: 10, lineHeight: 14, fontFamily: "Inter_600SemiBold", letterSpacing: 10 * 0.12, color: `rgba(${FG},0.45)` },
  entryValue: { minWidth: "60%", flex: 1, fontSize: 13, lineHeight: 20, fontFamily: "Inter_400Regular", color: `rgba(${FG},0.8)` },

  // 空态（虚线框）
  emptyBox: {
    borderRadius: 16,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: `rgba(${FG},0.1)`,
    backgroundColor: `rgba(${FG},0.03)`,
    paddingHorizontal: 16,
    paddingVertical: 20,
    alignItems: "center",
  },
  emptyTitle: { fontSize: 14, lineHeight: 20, fontFamily: "Inter_500Medium", color: `rgba(${FG},0.7)`, textAlign: "center" },
  emptyDesc: { marginTop: 4, fontSize: 12, lineHeight: 20, fontFamily: "Inter_400Regular", color: `rgba(${FG},0.45)`, textAlign: "center" },

  // Memory
  memGroups: { gap: 20 },
  memGroupHeader: { flexDirection: "row", alignItems: "baseline", gap: 8, marginBottom: 8, paddingHorizontal: 4 },
  memGroupLabel: { fontSize: 10, lineHeight: 14, fontFamily: "Inter_600SemiBold", letterSpacing: 10 * 0.16, color: `rgba(${FG},0.45)` },
  memGroupCount: { fontSize: 10, lineHeight: 14, fontFamily: "Inter_500Medium", color: `rgba(${FG},0.3)` },
  memItems: { gap: 12 },
  memText: { fontSize: 13, lineHeight: 24, fontFamily: "Inter_400Regular", color: `rgba(${FG},0.85)` },
  memAttr: { marginTop: 4, fontSize: 11, lineHeight: 15, fontFamily: "Inter_400Regular", color: `rgba(${FG},0.45)` },
  memFooter: {
    marginTop: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    borderRadius: 16,
    backgroundColor: "rgba(255,255,255,0.45)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.6)",
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  memCount: { fontSize: 11, lineHeight: 15, fontFamily: "Inter_400Regular", color: `rgba(${FG},0.45)`, fontVariant: ["tabular-nums"] },
  loadMoreBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 12,
    backgroundColor: `rgba(${FG},0.05)`,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  loadMoreDisabled: { opacity: 0.4 },
  loadMoreText: { fontSize: 11, lineHeight: 15, fontFamily: "Inter_500Medium", color: `rgba(${FG},0.55)` },

  // Goals grid
  goalsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  goalShadow: { borderRadius: 24, boxShadow: GLASS_SHADOW },
  goalPressed: { transform: [{ scale: 0.98 }] },
  goalClip: { borderRadius: 24, overflow: "hidden" },
  goalBorder: {
    ...absoluteFill,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: GLASS_BORDER,
    boxShadow: "inset 0 1px 1px rgba(255,255,255,0.6)",
  },
  goalImageArea: { height: 96, backgroundColor: `rgba(${FG},0.03)`, alignItems: "center", justifyContent: "center" },
  goalBody: { padding: 12 },
  goalTitleRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  goalTitle: { fontSize: 14, lineHeight: 20, fontFamily: "Inter_600SemiBold", color: "#1d2130" },
  goalBar: { height: 6, borderRadius: 999, backgroundColor: `rgba(${FG},0.1)`, overflow: "hidden", marginBottom: 8 },
  goalBarFill: { height: "100%", borderRadius: 999 },
  goalPctRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 8 },
  goalPct: { fontSize: 18, lineHeight: 28, fontFamily: "Inter_600SemiBold", color: "#1d2130", fontVariant: ["tabular-nums"] },
  goalPill: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  goalPillText: { fontSize: 10, lineHeight: 14, fontFamily: "Inter_500Medium" },
  goalSummaryRow: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", gap: 8 },
  goalSummary: { flex: 1, fontSize: 11, lineHeight: 15, fontFamily: "Inter_400Regular", color: `rgba(${FG},0.55)` },
});
