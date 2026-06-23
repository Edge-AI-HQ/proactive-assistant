/**
 * Card chat 顶部「上下文条」——web ui-web/card/card-chat 的 CardContextHeaderSlot
 * 的 RN 介质版：玻璃条显示 CONTEXT 标签 + 这张卡要做的事（reminder→summary，
 * 否则 primaryAction.label），点击 onOpen 展开完整卡片详情（CardDetailSheet：
 * 执行计划 / WHY NOW / SOURCES / 推理）。web blur(16)+白底 0.5 → RN expo-blur +
 * 白覆盖。web 在条里直接预览执行计划前 3 步（来自 card.detail.executionPlan，静态）；
 * RN 的 IntentCard 不带静态 plan（实时 run 才有），为避免与会话同线程的二次 SSE
 * 订阅，plan 放进点开的 CardDetailSheet 里（同一条 chevron 一步可达），条本身只做
 * 「上下文 + 快捷进入详情」。
 */
import { Pressable, StyleSheet, Text, View } from "react-native";
import { BlurView } from "expo-blur";
import { ChevronUp } from "lucide-react-native";
import { isReminderCard, type IntentCard } from "@pin-ai/core";

const FG = "29,33,48";

export default function CardContextHeaderSlot({
  card,
  onOpen,
}: {
  card: IntentCard;
  onOpen: () => void;
}) {
  const brief = isReminderCard(card)
    ? card.summary
    : card.primaryAction?.label || card.summary;

  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel="View card details"
        style={({ pressed }) => [styles.button, pressed && styles.pressed]}
      >
        <BlurView intensity={20} tint="light" style={[StyleSheet.absoluteFill, styles.blurRound]} />
        <View style={[StyleSheet.absoluteFill, styles.tint]} />
        <View style={styles.row}>
          <View style={styles.col}>
            <Text style={styles.label}>CONTEXT</Text>
            {brief ? (
              <Text style={styles.brief} numberOfLines={2}>
                {brief}
              </Text>
            ) : null}
          </View>
          <ChevronUp size={13} color={`rgba(${FG},0.3)`} strokeWidth={2} style={styles.chevron} />
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 },
  button: { borderRadius: 16, overflow: "hidden", borderWidth: 1, borderColor: `rgba(${FG},0.08)` },
  pressed: { opacity: 0.85 },
  // expo-blur 在 iOS 不跟随父级 overflow:hidden 裁圆角，borderRadius 直接给
  // BlurView + tint（与 button 的 16 一致），否则毛玻璃填成方角。
  tint: { backgroundColor: "rgba(255,255,255,0.5)", borderRadius: 16 },
  blurRound: { borderRadius: 16 },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 8, paddingHorizontal: 16, paddingVertical: 12 },
  col: { flex: 1, minWidth: 0 },
  label: { fontSize: 11, fontFamily: "Inter_600SemiBold", letterSpacing: 0.55, color: `rgba(${FG},0.4)`, marginBottom: 4 },
  brief: { fontSize: 13, fontFamily: "Inter_400Regular", color: `rgba(${FG},0.8)`, lineHeight: 18 },
  chevron: { marginTop: 2 },
});
