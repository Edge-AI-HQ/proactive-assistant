/**
 * CONNECT 页——web `ui-web/connect/ControlPanel.tsx` 的 RN 对应物：
 * 页头 → 双统计卡（DATA SOURCES n of 7 / DEVICES n paired）→ AMBIENT SOURCES
 * 品红 mesh 卡（可展开 → DeviceConnections 设备列表，点设备下钻 DeviceTimeline）
 * → DATA SOURCES（DataConnections：Recommended 折叠组 + catalog + custom MCP +
 * Website logins）。
 *
 * composio state 由 AppShell 持有传入（= web AppLayout 持 useComposio 跨 view
 * 保活）。mesh 卡的 `backdrop-blur-xl` 是 tailwind utility、**不被
 * native-power-save 砍**（它只砍 .glass-card/.aurora-layer 类）→ dev 真机有
 * blur(24) → BlurView 40。统计卡/分组卡是 .glass-card{,-strong} → 无 blur →
 * GlassCard。
 */
import { memo, useEffect, useMemo, useState } from "react";
import { LayoutAnimation, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { BlurView } from "expo-blur";
import Animated, { FadeInUp } from "react-native-reanimated";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, Smartphone } from "lucide-react-native";
import { useUserDevices, type ComposioState } from "@pin-ai/state";

import { GlassCard } from "../ui/GlassCard";
import PageHeader from "../components/app/PageHeader";
import DataConnections, {
  INPUT_CATEGORIES,
  isDataSourceConnected,
} from "../components/connect/DataConnections";
import DeviceConnections from "../components/connect/DeviceConnections";
import { EM_TIGHT, tracking } from "../ui/typography";
import type { HeaderProps } from "./AmbientScreen";

const FG = "29,33,48";
const fg = (a: number) => `rgba(${FG},${a})`;
const MUTED_FG = "rgb(115,123,140)"; // --muted-foreground hsl(220 10% 50%)
/** web mesh 卡品红 hsl(304 75% 63%) ≈ rgb(231,90,222)。 */
const PINK = "231,90,222";
const pink = (a: number) => `rgba(${PINK},${a})`;

/** web motion.div initial opacity 0 / y 12。 */
const sectionEntering = FadeInUp.duration(240).withInitialValues({
  opacity: 0,
  transform: [{ translateY: 12 }],
});

function ConnectScreen({
  headerProps,
  composio,
}: {
  headerProps: HeaderProps;
  composio: ComposioState;
}) {
  const { t } = useTranslation("connect");
  const [meshExpanded, setMeshExpanded] = useState(false);

  // 与 DeviceConnections 同一 hook（共享 TQ 缓存，注册即同步计数）。
  const { devices } = useUserDevices(true);
  const configured = composio.keyStatus?.configured;
  const { loadConnections } = composio;
  // web ControlPanel 同款依赖：只跟 configured + 稳定的 loadConnections 回调。
  // ⚠️ 不能依赖 composio 整对象——useComposio 每 render 返回新字面量，会
  // effect→setState→re-render 无限循环。
  useEffect(() => {
    if (configured !== true) return;
    void loadConnections();
  }, [configured, loadConnections]);

  const peerCount = useMemo(() => devices.filter((d) => d.platform !== "web").length, [devices]);

  const dataSourceTotal = useMemo(
    () =>
      INPUT_CATEGORIES.reduce(
        (sum, cat) => sum + cat.sources.filter((s) => Boolean(s.composioId)).length,
        0,
      ),
    [],
  );
  const dataSourceConnected = useMemo(() => {
    let n = 0;
    for (const cat of INPUT_CATEGORIES) {
      for (const src of cat.sources) {
        if (isDataSourceConnected(src, composio.connections)) n++;
      }
    }
    return n;
  }, [composio.connections]);

  const toggleMesh = () => {
    LayoutAnimation.configureNext(LayoutAnimation.create(250, "easeInEaseOut", "opacity"));
    setMeshExpanded((v) => !v);
  };

  return (
    <View style={styles.flex1}>
      <PageHeader
        title={
          // web h1：text-2xl(24) / font-semibold / tracking-tight / mb-0.5。
          <Text
            style={{
              fontSize: 24,
              fontFamily: "Inter_600SemiBold",
              letterSpacing: tracking(24, EM_TIGHT),
              lineHeight: 28,
              color: "#1d2130",
              marginBottom: 2,
            }}
          >
            {t("controlPanel.title")}
          </Text>
        }
        subtitle={
          // web 副标题：text-xs(12) text-muted-foreground。
          <Text
            style={{ fontSize: 12, lineHeight: 16, fontFamily: "Inter_400Regular", color: MUTED_FG }}
          >
            {t("controlPanel.subtitle")}
          </Text>
        }
        {...headerProps}
      />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* 顶部双统计卡 */}
        <View style={styles.statsRow}>
          <GlassCard style={[styles.flex1, styles.statCard]}>
            <Text style={styles.statLabel}>{t("controlPanel.dataSources").toUpperCase()}</Text>
            <View style={styles.statValueRow}>
              <Text style={styles.statValue}>{dataSourceConnected}</Text>
              <Text style={styles.statTotal}>{t("controlPanel.ofTotal", { total: dataSourceTotal })}</Text>
            </View>
            <View style={styles.statStatusRow}>
              <View style={styles.dotEmerald} />
              <Text style={styles.statStatusText}>{t("controlPanel.allSynced")}</Text>
            </View>
          </GlassCard>
          <GlassCard style={[styles.flex1, styles.statCard]}>
            <Text style={styles.statLabel}>{t("controlPanel.devices").toUpperCase()}</Text>
            <View style={styles.statValueRow}>
              <Text style={styles.statValue}>{peerCount}</Text>
              <Text style={styles.statTotal}>{t("controlPanel.paired")}</Text>
            </View>
            <View style={styles.statStatusRow}>
              <View style={styles.dotEmerald} />
              <Text style={styles.statStatusText}>{t("controlPanel.allSynced")}</Text>
            </View>
          </GlassCard>
        </View>

        {/* AMBIENT SOURCES —— 品红 mesh 卡（真 DeviceConnections 在里面） */}
        <View>
          <View style={styles.sectionLabelRow}>
            <View style={[styles.sectionDot, { backgroundColor: pink(1) }]} />
            <Text style={[styles.sectionLabel, { color: pink(1) }]}>{t("controlPanel.ambientSources").toUpperCase()}</Text>
          </View>
          <Animated.View entering={sectionEntering} style={styles.meshCard}>
            {/* web backdrop-blur-xl（utility，dev 真机有 blur(24)）→ BlurView 40 */}
            <BlurView intensity={40} tint="light" style={StyleSheet.absoluteFill} />
            <View style={[StyleSheet.absoluteFill, { backgroundColor: pink(0.04) }]} />
            <Pressable onPress={toggleMesh} accessibilityRole="button" accessibilityState={{ expanded: meshExpanded }}>
              <View style={styles.meshHeader}>
                <View style={styles.meshIconBox}>
                  <Smartphone size={18} strokeWidth={1.5} color={pink(1)} />
                </View>
                <View style={styles.flex1}>
                  <View style={styles.meshTitleRow}>
                    <Text style={styles.meshTitle}>{t("controlPanel.devices")}</Text>
                    <View style={styles.meshBadge}>
                      <Text style={styles.meshBadgeText}>{t("controlPanel.activeCount", { count: peerCount })}</Text>
                    </View>
                  </View>
                  <Text style={styles.meshDesc}>{t("controlPanel.meshDescription")}</Text>
                </View>
                {meshExpanded ? (
                  <ChevronUp size={16} color={fg(0.3)} />
                ) : (
                  <ChevronDown size={16} color={fg(0.3)} />
                )}
              </View>
            </Pressable>
            {meshExpanded ? (
              <View style={styles.meshBody}>
                <View style={styles.meshDivider} />
                <DeviceConnections />
              </View>
            ) : null}
          </Animated.View>
        </View>

        {/* DATA SOURCES —— composio 分类（真 OAuth） */}
        <View>
          <View style={styles.sectionLabelRow}>
            <View style={[styles.sectionDot, { backgroundColor: fg(0.4) }]} />
            <Text style={[styles.sectionLabel, { color: fg(0.5) }]}>{t("controlPanel.dataSources").toUpperCase()}</Text>
          </View>
          <DataConnections composio={composio} />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex1: { flex: 1 },
  // 页头块 web mb-5(20)：PageHeader pb-2(8) → 内容 pt 12。
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 48, gap: 16 },

  statsRow: { flexDirection: "row", gap: 10 },
  statCard: { padding: 16 },
  statLabel: {
    fontSize: 10,
    lineHeight: 14,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 10 * 0.12,
    color: fg(0.5),
    marginBottom: 4,
  },
  statValueRow: { flexDirection: "row", alignItems: "baseline", gap: 6 },
  statValue: { fontSize: 24, lineHeight: 24, fontFamily: "Inter_600SemiBold", color: "#1d2130" },
  // dev leading-none(line-height:1) 在 CSS 下中文溢出行框仍画全、不裁；RN 里
  // lineHeight==fontSize 会裁掉中文字形顶部（"已配对"）→ 提到 20(~1.4×)给 CJK 头部
  // 留空间。baseline 对齐下数字与文字仍齐，且 <statValue 的 24 行高、不撑高该行。
  statTotal: { fontSize: 14, lineHeight: 20, fontFamily: "Inter_400Regular", color: fg(0.4) },
  statStatusRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8 },
  dotEmerald: { width: 6, height: 6, borderRadius: 999, backgroundColor: "#10b981" },
  statStatusText: { fontSize: 10, lineHeight: 14, fontFamily: "Inter_500Medium", color: fg(0.6) },

  sectionLabelRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8, paddingHorizontal: 4 },
  sectionDot: { width: 4, height: 4, borderRadius: 999 },
  sectionLabel: { fontSize: 10, lineHeight: 14, fontFamily: "Inter_600SemiBold", letterSpacing: 10 * 0.12 },

  meshCard: {
    borderRadius: 24,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: pink(0.25),
    boxShadow: "0 8px 24px -12px rgba(231,90,222,0.25)",
  },
  meshHeader: { flexDirection: "row", alignItems: "center", gap: 12, padding: 16 },
  meshIconBox: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: pink(0.12),
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  meshTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  meshTitle: { fontSize: 14, lineHeight: 20, fontFamily: "Inter_600SemiBold", color: "#1d2130" },
  meshBadge: { backgroundColor: pink(0.1), paddingHorizontal: 6, paddingVertical: 2, borderRadius: 18 },
  meshBadgeText: { fontSize: 10, lineHeight: 14, fontFamily: "Inter_600SemiBold", color: pink(1) },
  meshDesc: { marginTop: 2, fontSize: 11, lineHeight: 15, fontFamily: "Inter_400Regular", color: fg(0.5) },
  meshBody: { paddingHorizontal: 16, paddingBottom: 16 },
  meshDivider: { height: 1, backgroundColor: pink(0.15), marginBottom: 12 },
});

// memo：AppShell 切页/开关抽屉时本屏 props 全稳定（含 composio——useComposio 返回
// 对象已 memo 化），memo 截断整屏无关重渲（切页卡顿修复 2026-07-07）。
export default memo(ConnectScreen);
