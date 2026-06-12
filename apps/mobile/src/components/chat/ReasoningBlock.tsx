/**
 * 折叠的 extended-thinking 块——web ReasoningBlock 的 RN 对应物：
 * 默认折叠；流式中标签 "Thinking…"（带脉冲动画），完成态 "Thought
 * process"；点击展开/收起灰斜体思考全文。
 */
import { useEffect, useRef, useState } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";

export default function ReasoningBlock({
  text,
  streaming,
}: {
  text: string;
  /** 该 reasoning 是 turn 的活跃尾部（仍在追加）。 */
  streaming: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const pulse = useRef(new Animated.Value(0.45)).current;

  useEffect(() => {
    if (!streaming) {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.45, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [streaming, pulse]);

  return (
    <View style={styles.block}>
      <Pressable onPress={() => setExpanded((v) => !v)} hitSlop={6}>
        <Animated.Text style={[styles.label, { opacity: streaming ? pulse : 1 }]}>
          {streaming ? "Thinking…" : "Thought process"} {expanded ? "▾" : "▸"}
        </Animated.Text>
      </Pressable>
      {expanded ? <Text style={styles.text}>{text}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { marginTop: 6 },
  label: { fontSize: 13, color: "#a1a1aa", fontWeight: "500" },
  text: { marginTop: 6, fontSize: 13, color: "#a1a1aa", fontStyle: "italic", lineHeight: 18 },
});
