/**
 * `notify_user` 卡——web ui-web/chat/conversation/AssistantEntry 的 NotifyCard
 * RN 介质版:agent 主动通知自带 "Notify you" chrome(Sparkles + 品红大写标签 +
 * 品红渐染玻璃卡),读起来是 AI 主动找你、不是在回复你。live 与历史回放同款。
 * web 的 radial-gradient(品红 0.10 → 透明 55%) + blur(20) → RN expo-blur +
 * 白覆盖 + LinearGradient 近似;入场 = web motion y6/0.26s 的 FadeInDown。
 */
import { StyleSheet, Text, View } from "react-native";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import { Sparkles } from "lucide-react-native";
import { useTranslation } from "react-i18next";

import MarkdownText from "./MarkdownText";

/** web AssistantEntry `text-[hsl(304_75%_45%)]` 同源品红。 */
const MAGENTA_TEXT = "hsl(304, 75%, 45%)";

/** notify_user tool-call 快照 args → 通知正文——逐字对齐 web
 *  ui-web/chat/conversation/_shared.tsx 的 notifyUserText(结构化
 *  `input.message`,否则 argsPreview 预览串)。 */
export function notifyUserText(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const root = raw as Record<string, unknown>;
  const inner =
    root.input && typeof root.input === "object"
      ? (root.input as Record<string, unknown>)
      : root;
  const msg = typeof inner.message === "string" ? inner.message.trim() : "";
  if (msg) return msg;
  const preview = typeof root.argsPreview === "string" ? root.argsPreview.trim() : "";
  return preview || null;
}

export default function NotifyCard({ text }: { text: string }) {
  const { t } = useTranslation("chat");
  return (
    <View style={styles.card}>
      <BlurView intensity={24} tint="light" style={[StyleSheet.absoluteFill, styles.rounded]} />
      <View style={[StyleSheet.absoluteFill, styles.tint]} />
      <LinearGradient
        // web radial(品红 0.10 @ 左上 → transparent 55%) 的线性近似;尾色用
        // 0 透明度品红避免 iOS 经灰过渡的暗边。
        colors={["hsla(304, 75%, 60%, 0.10)", "hsla(304, 75%, 60%, 0)"]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        locations={[0, 0.55]}
        style={[StyleSheet.absoluteFill, styles.rounded]}
      />
      <View style={styles.labelRow}>
        <Sparkles size={11} strokeWidth={2} color={MAGENTA_TEXT} />
        <Text style={styles.label}>{t("notify.label").toUpperCase()}</Text>
      </View>
      <MarkdownText text={text} />
    </View>
  );
}

const styles = StyleSheet.create({
  // web: mb-4 rounded-2xl border border-[hsl(304_75%_55%)]/20 px-4 py-3。
  card: {
    marginBottom: 16,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "hsla(304, 75%, 55%, 0.2)",
    paddingHorizontal: 16,
    paddingVertical: 12,
    overflow: "hidden",
  },
  // expo-blur iOS 不跟随父级 overflow 裁圆角,borderRadius 直接给覆盖层。
  rounded: { borderRadius: 16 },
  tint: { backgroundColor: "rgba(255,255,255,0.5)", borderRadius: 16 },
  labelRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 6 },
  // web Text variant="micro"(10) weight="bold" tracking-[0.18em]。
  label: {
    fontSize: 10,
    lineHeight: 14,
    letterSpacing: 1.8,
    color: MAGENTA_TEXT,
    fontFamily: "Geist_700Bold",
  },
});
