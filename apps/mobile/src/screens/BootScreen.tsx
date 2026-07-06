/**
 * Boot 态共享件 —— dev `proactive-ai-frontend/src/App.tsx` 顶部 boot 背景 +
 * BootstrapError 的 RN 对应物。
 *
 * - FlowBackdrop：静止流动渐变 + 白罩，BootstrapError 与 OnboardingFlow 共用背景层。
 *   （原冷启 Spinner 已被 SplashScreen 取代，转环那块删除。）
 * - BootstrapError：settings 首拉重试后仍失败 → 原地 Retry 屏。
 *
 * 渐变静止取景换算：CSS background-size 400% + position 0% 0% 意味着屏幕只露出
 * 135deg 渐变头部 0%→25% 段；落在该段的停点 = 0%: hsl(220 30% 94%)、15%:
 * hsl(280 30% 90%)、25% 处为 280→320 段的 2/3 插值 ≈ hsl(307 29% 91%)。
 * 映射成三停点 LinearGradient（0 / 0.6 / 1），整层 opacity 0.6（dev opacity-60）。
 */
import { StyleSheet, Text, View, Pressable } from "react-native";
import { LinearGradient } from "expo-linear-gradient";

/** token --background: 220 30% 96%（dev body 底色，App.tsx styles.safe 同源）。 */
const BG = "#f2f4f8";
const FG = "230, 25%, 15%";
const fg = (a?: number) => (a === undefined ? `hsl(${FG})` : `hsla(${FG}, ${a})`);

/** dev Spinner 背景层（BootScreen / BootstrapError / OnboardingFlow 共用）。
 *  白罩浓度：dev Spinner=white/20，onboarding 壳=white/30。 */
export function FlowBackdrop({ veilOpacity = 0.2 }: { veilOpacity?: number }) {
  return (
    <>
      <View style={[StyleSheet.absoluteFill, styles.base]} />
      <LinearGradient
        colors={["hsl(220, 30%, 94%)", "hsl(280, 30%, 90%)", "hsl(307, 29%, 91%)"]}
        locations={[0, 0.6, 1]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[StyleSheet.absoluteFill, styles.flow]}
      />
      <View
        style={[StyleSheet.absoluteFill, { backgroundColor: `rgba(255,255,255,${veilOpacity})` }]}
      />
    </>
  );
}

/** dev App.tsx BootstrapError：settings 首拉重试后仍失败 → 原地 Retry（不用重启 App）。
 *  卡片 = glass-card-strong（rounded-3xl=24 + 白渐变 135deg 0.55→0.25 + white/45 边
 *  + inset/外阴影；native 下无 backdrop blur）。文案与 dev 硬编码一致（未 i18n）。 */
export function BootstrapError({ onRetry }: { onRetry: () => void }) {
  return (
    <View style={styles.root}>
      <FlowBackdrop />
      <View style={styles.errorCard}>
        <LinearGradient
          colors={["rgba(255,255,255,0.55)", "rgba(255,255,255,0.25)"]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <Text style={styles.errorText}>
          Couldn't reach the server. Check your connection and try again.
        </Text>
        {/* ⚠️ NativeWind 吞 Pressable 的 style → children-as-function + 内层 View。 */}
        <Pressable onPress={onRetry} accessibilityRole="button">
          {({ pressed }) => (
            <View style={[styles.retryButton, pressed && styles.retryButtonPressed]}>
              <Text style={styles.retryText}>Retry</Text>
            </View>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  base: { backgroundColor: BG },
  flow: { opacity: 0.6 },
  errorCard: {
    width: "100%",
    maxWidth: 384, // dev max-w-sm
    borderRadius: 24, // rounded-3xl（radius token 只覆盖 lg/md/sm，3xl 走 Tailwind 默认）
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.45)",
    padding: 32, // p-8
    overflow: "hidden",
    marginHorizontal: 24,
    boxShadow:
      "inset 0 1px 1px rgba(255,255,255,0.6), 0 4px 16px rgba(0,0,0,0.04), 0 1px 4px rgba(0,0,0,0.02)",
  },
  errorText: {
    fontFamily: "Inter_400Regular",
    fontSize: 14, // text-sm
    lineHeight: 20,
    color: fg(0.8),
    textAlign: "center",
  },
  retryButton: {
    marginTop: 20, // mt-5
    width: "100%",
    borderRadius: 12, // rounded-xl（Tailwind 默认，未被 token 覆盖）
    borderWidth: 1,
    borderColor: fg(0.1),
    backgroundColor: "rgba(255,255,255,0.6)",
    paddingHorizontal: 16, // px-4
    paddingVertical: 12, // py-3
    alignItems: "center",
    boxShadow: "0 1px 2px rgba(0,0,0,0.05)", // shadow-sm
  },
  retryButtonPressed: { backgroundColor: "rgba(255,255,255,0.8)" }, // hover:bg-white/80 的按压对应
  retryText: {
    fontFamily: "Inter_500Medium",
    fontSize: 14, // text-sm font-medium
    lineHeight: 20,
    color: fg(0.8),
  },
});
