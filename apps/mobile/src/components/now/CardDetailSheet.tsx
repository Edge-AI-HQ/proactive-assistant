/**
 * 卡片详情底部抽屉——web 的 card detail drawer 对应物（球面卡 tap 后）：
 * basket 标签 + 标题 + whyNow + summary + 操作（Confirm 主黑钮 /
 * Steer / Snooze / Dismiss）。
 */
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import type { VisibleCardEntry } from "@pin-ai/core";

export default function CardDetailSheet({
  entry,
  onClose,
  onConfirm,
  onSteer,
  onSnooze,
  onDismiss,
}: {
  entry: VisibleCardEntry | null;
  onClose: () => void;
  onConfirm: (e: VisibleCardEntry) => void;
  onSteer: (e: VisibleCardEntry) => void;
  onSnooze: (e: VisibleCardEntry) => void;
  onDismiss: (e: VisibleCardEntry) => void;
}) {
  const card = entry?.card;
  return (
    <Modal
      visible={entry !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      {entry && card ? (
        <View className="flex-1 bg-background">
          <ScrollView className="flex-1 px-6 pt-6" contentContainerClassName="pb-10">
            <Text
              className="text-[11px] tracking-[1.5px] text-muted-foreground"
              style={{ fontFamily: "Inter_600SemiBold" }}
            >
              {card.goalBasket.toUpperCase()}
            </Text>
            <Text
              className="mt-2 text-[22px] leading-7 text-foreground"
              style={{ fontFamily: "Inter_700Bold" }}
            >
              {card.title}
            </Text>
            {card.whyNow ? (
              <Text className="mt-3 text-[13px] leading-5 text-amber-700" style={{ fontFamily: "Inter_500Medium" }}>
                {card.whyNow}
              </Text>
            ) : null}
            {card.summary ? (
              <Text className="mt-3 text-[15px] leading-6 text-foreground/80" style={{ fontFamily: "Inter_400Regular" }}>
                {card.summary}
              </Text>
            ) : null}
          </ScrollView>
          <View className="px-6 pb-10 gap-2">
            <Pressable
              onPress={() => onConfirm(entry)}
              className="items-center rounded-2xl bg-foreground py-3.5"
            >
              <Text className="text-[15px] text-white" style={{ fontFamily: "Inter_600SemiBold" }}>
                {card.primaryAction?.label || "Confirm"}
              </Text>
            </Pressable>
            <View className="flex-row gap-2">
              {[
                { label: "Steer", fn: onSteer },
                { label: "Snooze", fn: onSnooze },
                { label: "Dismiss", fn: onDismiss },
              ].map(({ label, fn }) => (
                <Pressable
                  key={label}
                  onPress={() => fn(entry)}
                  className="flex-1 items-center rounded-2xl bg-white/80 border border-white/70 py-3"
                >
                  <Text className="text-[14px] text-foreground/75" style={{ fontFamily: "Inter_500Medium" }}>
                    {label}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Pressable onPress={onClose} className="items-center py-2.5">
              <Text className="text-[13px] text-muted-foreground" style={{ fontFamily: "Inter_500Medium" }}>
                Close
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </Modal>
  );
}
