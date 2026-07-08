/**
 * PROFILE 页——dev `MirrorMobile.tsx`（移动布局 shell）+ `ui-web/profile/mirror.tsx`
 * （panel 层）的 RN 对应物（lifelong-memory 迁移后的极简画像设计）。
 *
 * 结构对齐 dev：页头 → [error 卡] → Identity/Goals 胶囊 switcher → 横向 swipe pager：
 *   - Identity pane = USER 段 + MEMORY 段（各 glass-card-strong 包一个 PortraitSection，
 *     竖直堆叠 space-y-5），对齐 dev IdentityPanel。
 *   - Goals pane = GOALS 段（glass-card-strong 包 PortraitSection），对齐 dev GoalsPanel。
 * PortraitSection = 标题 + 计数药丸 + 描述 → 一串 entry 卡（glass-card p-4 内 markdown），
 * 空则 EmptyState（dev PortraitSection / EmptyState 同构）。
 *
 * 数据 = @pin-ai/state 的 usePortrait（L2 画像六段 slot：USER/MEMORY/GOALS…）；每段 content
 * 是 `§`-分隔的 entry（core splitPortraitEntries），逐条用 MarkdownText 渲染（与 dev
 * MarkdownContent 同源）。pager 用 RN 标准 ScrollView pagingEnabled（原生分页物理，替代
 * web framer 手写 commit 阈值——架构差异，行为等价：跟手横滑 + 松手 snap）。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
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
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { Loader2 } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { splitPortraitEntries } from "@pin-ai/core";
import { portraitKeys, usePortrait } from "@pin-ai/state";
import { useQueryClient } from "@tanstack/react-query";

import { GlassCard } from "../ui/GlassCard";
import { usePageActive } from "../components/app/KeepAlivePage";
import PageHeader from "../components/app/PageHeader";
import MarkdownText from "../components/chat/MarkdownText";
import { EM_TIGHT, tracking } from "../ui/typography";
import type { HeaderProps } from "./AmbientScreen";

const FG = "29,33,48"; // --foreground ≈ rgb(29,33,48)
const BACKGROUND = "#f2f4f8"; // --background hsl(220 30% 96%)
const MUTED_FG = "rgb(115,123,140)"; // --muted-foreground hsl(220 10% 50%)
const ROSE_500 = "#f43f5e";

// Identity / Goals 两个 pane 并排，横向 swipe 切换（dev TOP_TABS）。
const TOP_TABS = ["identity", "goals"] as const;
type TopTab = (typeof TOP_TABS)[number];

/** dev sectionMotion：opacity 0→1 / y 12→0 / 0.24s。 */
const sectionEntering = FadeInUp.duration(240).withInitialValues({
  opacity: 0,
  transform: [{ translateY: 12 }],
});

/** 旋转（dev Loader2 animate-spin）。 */
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

/** dev EmptyState：虚线框空态。⚠️ RN iOS 圆角+dashed 可能渲染成实线（已知限制），真机确认。 */
function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <View style={styles.emptyBox}>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyDesc}>{description}</Text>
    </View>
  );
}

/** dev PortraitEntryCard——单条 §-entry 卡（glass-card p-4 内 markdown）。 */
function PortraitEntryCard({ entry }: { entry: string }) {
  return (
    <GlassCard style={styles.entryCard}>
      <MarkdownText text={entry} />
    </GlassCard>
  );
}

/**
 * dev PortraitSection——标题（title + 计数药丸 + 描述）叠一串 entry 卡，空则 EmptyState。
 * `content` 是 slot 原始 markdown，这里按 `§` 切成 entries。
 */
function PortraitSection({
  title,
  description,
  content,
  emptyTitle,
  emptyDescription,
}: {
  title: string;
  description: string;
  content: string | undefined;
  emptyTitle: string;
  emptyDescription: string;
}) {
  const entries = useMemo(() => splitPortraitEntries(content), [content]);
  return (
    <Animated.View entering={sectionEntering}>
      <View style={styles.sectionHeader}>
        <View style={styles.sectionTitleRow}>
          <Text style={styles.panelTitle}>{title}</Text>
          <View style={styles.countPill}>
            <Text style={styles.countPillText}>{entries.length}</Text>
          </View>
        </View>
        <Text style={styles.panelDesc}>{description}</Text>
      </View>
      {entries.length === 0 ? (
        <EmptyState title={emptyTitle} description={emptyDescription} />
      ) : (
        <View style={styles.entriesWrap}>
          {entries.map((entry, i) => (
            <PortraitEntryCard key={i} entry={entry} />
          ))}
        </View>
      )}
    </Animated.View>
  );
}

/** dev IdentityPanel：USER 画像 + MEMORY 画像，竖直堆叠（space-y-5）。 */
function IdentityPanel({ slots }: { slots: Record<string, string> }) {
  const { t } = useTranslation("profile");
  return (
    <View style={styles.paneStack}>
      <GlassCard style={styles.panelSection}>
        <PortraitSection
          title={t("portrait.user.title")}
          description={t("portrait.user.description")}
          content={slots.USER}
          emptyTitle={t("portrait.user.emptyTitle")}
          emptyDescription={t("portrait.user.emptyDescription")}
        />
      </GlassCard>
      <GlassCard style={styles.panelSection}>
        <PortraitSection
          title={t("portrait.memory.title")}
          description={t("portrait.memory.description")}
          content={slots.MEMORY}
          emptyTitle={t("portrait.memory.emptyTitle")}
          emptyDescription={t("portrait.memory.emptyDescription")}
        />
      </GlassCard>
    </View>
  );
}

/** dev GoalsPanel：GOALS 画像 entries。 */
function GoalsPanel({ slots }: { slots: Record<string, string> }) {
  const { t } = useTranslation("profile");
  return (
    <GlassCard style={styles.panelSection}>
      <PortraitSection
        title={t("portrait.goals.title")}
        description={t("portrait.goals.description")}
        content={slots.GOALS}
        emptyTitle={t("portrait.goals.emptyTitle")}
        emptyDescription={t("portrait.goals.emptyDescription")}
      />
    </GlassCard>
  );
}

function ProfileScreen({ headerProps }: { headerProps: HeaderProps }) {
  const { t } = useTranslation("profile");
  // Lifelong-memory 数据层：L2 portrait 六段 markdown slot（USER/MEMORY/GOALS…）。
  const { slots, loading, error } = usePortrait();

  // KeepAlive 常驻不卸载 → 复刻 dev「每次进 tab 重挂载必 refetch」语义：
  // 切回本页时失效 portrait（active query 立即后台重拉，SWR 不闪 loading）。
  const pageActive = usePageActive();
  const queryClient = useQueryClient();
  const wasActiveRef = useRef(pageActive);
  useEffect(() => {
    if (pageActive && !wasActiveRef.current) {
      void queryClient.invalidateQueries({ queryKey: portraitKeys.all });
    }
    wasActiveRef.current = pageActive;
  }, [pageActive, queryClient]);

  const [activeTab, setActiveTab] = useState<TopTab>("identity");

  const pagerRef = useAnimatedRef<Animated.ScrollView>();
  // pane 要显式宽高：横向 ScrollView 里的子 View 无界时，内嵌竖向 ScrollView 不滚。
  const [pagerSize, setPagerSize] = useState({ w: 0, h: 0 });
  const pagerWidth = pagerSize.w;
  // pill 玻璃条实测宽 → 黑 thumb 宽（两侧 p-1 + 中间 gap-1 = 12）。
  const [pillWidth, setPillWidth] = useState(0);
  const thumbWidth = pillWidth > 0 ? (pillWidth - 12) / 2 : 0;
  // pager 滚动进度（UI 线程共享值）：驱动 pill thumb 位移 + 文字色渐变。
  const scrollX = useSharedValue(0);

  // pill 点击：滚 pager 到目标 pane（dev animate trackX spring）；thumb/文字由 scrollX 跟随。
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

  // 视口（重）量 或 切回本页（pageActive）时，把 pager 强制对回当前 activeTab pane。
  // 加 pageActive 是修「切回 Profile 时停在半态、露出隔壁 pane 一条」：分页被全局抽屉
  // 左滑手势拦腰打断会停在没吸附的中间位（原生 paging 的 snap 没触发），带上 pageActive
  // 每次回到本页强制吸附回整页。
  useEffect(() => {
    if (pagerWidth > 0) {
      const x = TOP_TABS.indexOf(activeTab) * pagerWidth;
      pagerRef.current?.scrollTo({ x, animated: false });
      // 同步 pill 黑 thumb：scrollTo(animated:false) 未必回吐 onScroll,不显式设 scrollX
      // 则 thumb 可能停在半态旧值、和已吸附回整页的 pane 对不上。
      scrollX.value = x;
    }
    // activeTab 不进 deps：tab 切换的滚动由 selectTab 的 animated scrollTo / 手势自己完成，
    // 进 deps 会和那个 animated 滚动打架。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pagerWidth, pageActive]);

  return (
    <View style={styles.flex1}>
      <PageHeader
        title={
          // dev MirrorMobile h1：text-2xl(24) / font-semibold / tracking-tight(-0.025em) / 默认 lh 32。
          <Text
            style={{
              fontSize: 24,
              fontFamily: "Inter_600SemiBold",
              letterSpacing: tracking(24, EM_TIGHT),
              lineHeight: 28,
              color: "#1d2130",
            }}
          >
            {t("goalsView.title")}
          </Text>
        }
        subtitle={
          // dev 副标题：mt-0.5 text-xs(12) text-muted-foreground。
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
        // dev：Loader2 16 spin + bodySm foreground/40，py-14。
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

          {/* Identity / Goals pill switcher（dev inline 玻璃：blur(20) + 180° 白渐变 .7→.5 +
              white/50 边）。黑 pill = 滑动 thumb，由 pager scrollX 实时驱动。 */}
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

          {/* 横向 pager：两个 pane 并排，跟手横滑 + 原生 snap（dev framer drag track） */}
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
                {/* Identity pane — USER + MEMORY portrait, stacked */}
                <View style={{ width: pagerSize.w, height: pagerSize.h }}>
                  <ScrollView
                    style={styles.flex1}
                    showsVerticalScrollIndicator={false}
                    contentContainerStyle={styles.paneContent}
                  >
                    <IdentityPanel slots={slots} />
                  </ScrollView>
                </View>

                {/* Goals pane — GOALS portrait */}
                <View style={{ width: pagerSize.w, height: pagerSize.h }}>
                  <ScrollView
                    style={styles.flex1}
                    showsVerticalScrollIndicator={false}
                    contentContainerStyle={styles.paneContent}
                  >
                    <GoalsPanel slots={slots} />
                  </ScrollView>
                </View>
              </Animated.ScrollView>
            </GestureDetector>
          </View>
        </View>
      )}
    </View>
  );
}

const absoluteFill = { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 } as const;

const styles = StyleSheet.create({
  flex1: { flex: 1 },
  // 页头块 dev mb-6(24)：PageHeader 自带 pb-2(8) → 内容区补 pt 16。
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
  // dev pane：Identity space-y-5(20) / 两 pane 都 pb-2(8)
  paneContent: { paddingBottom: 8 },
  // dev IdentityPanel space-y-5(20)
  paneStack: { gap: 20 },

  // panel section：glass-card-strong p-4（native 与 glass-card 同渲染）
  panelSection: { padding: 16 },
  // entry 卡：glass-card p-4
  entryCard: { padding: 16 },

  // PortraitSection 标题区（dev mb-3）
  sectionHeader: { marginBottom: 12 },
  sectionTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  panelTitle: { fontSize: 14, lineHeight: 20, fontFamily: "Inter_600SemiBold", color: "#1d2130" },
  countPill: {
    borderRadius: 999,
    backgroundColor: `rgba(${FG},0.05)`,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  countPillText: { fontSize: 10, lineHeight: 14, fontFamily: "Inter_500Medium", color: `rgba(${FG},0.45)` },
  // dev caption(11) + leading-5(20) + mt-1(4) + foreground/42
  panelDesc: { marginTop: 4, fontSize: 11, lineHeight: 20, fontFamily: "Inter_400Regular", color: `rgba(${FG},0.42)` },

  // dev space-y-2.5(10)
  entriesWrap: { gap: 10 },

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
});

// memo：AppShell 切页/开关抽屉时本屏 props 全稳定（AppShell 侧 useCallback/useMemo），
// memo 截断整屏无关重渲（切页卡顿修复 2026-07-07）。
export default memo(ProfileScreen);
