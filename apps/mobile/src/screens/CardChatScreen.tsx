/**
 * Card chat（全屏 modal 内容）：header（卡片标题 + 关闭）+ ChatScreen 的
 * card 模式。confirm/steer 的 agent 指令经 bootstrap 自动作为首条消息发出
 * （与 web 的 card → chat 流转同构）。
 */
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { IntentCard } from "@pin-ai/core";

import ChatScreen from "./ChatScreen";
import AuroraBackground from "../ui/AuroraBackground";

export default function CardChatScreen({
  card,
  bootstrap,
  onClose,
}: {
  card: IntentCard;
  bootstrap?: string;
  onClose: () => void;
}) {
  return (
    <View style={styles.root}>
      {/* web card chat 同款 aurora 氛围底（替代纯色）。 */}
      <AuroraBackground />
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>
          {card.title}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close card chat"
          onPress={onClose}
          hitSlop={12}
        >
          <Text style={styles.close}>Done</Text>
        </Pressable>
      </View>
      <ChatScreen kind="card" cardId={card.id} bootstrap={bootstrap} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#f2f4f8" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(228,228,231,0.6)",
    backgroundColor: "rgba(250,249,247,0.72)",
  },
  title: { flex: 1, fontSize: 16, fontWeight: "600", color: "#1a1a1a", marginRight: 12 },
  close: { fontSize: 15, fontWeight: "600", color: "#2563eb" },
});
