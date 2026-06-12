/**
 * 自绘 bottom tab（状态驱动导航——与 web useAppNavigation 的哲学一致，
 * 两个 tab 还不值得引 react-navigation；stack/手势需求出现时再换）。
 */
import { Pressable, StyleSheet, Text, View } from "react-native";

export type TabKey = "now" | "tasks" | "chat" | "connect" | "me";

const TABS: { key: TabKey; label: string }[] = [
  { key: "now", label: "Now" },
  { key: "tasks", label: "Tasks" },
  { key: "chat", label: "Chat" },
  { key: "connect", label: "Connect" },
  { key: "me", label: "Me" },
];

export default function TabBar({
  active,
  onChange,
}: {
  active: TabKey;
  onChange: (tab: TabKey) => void;
}) {
  return (
    <View style={styles.bar}>
      {TABS.map((t) => (
        <Pressable key={t.key} style={styles.tab} onPress={() => onChange(t.key)}>
          <Text style={[styles.label, active === t.key && styles.activeLabel]}>{t.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#e4e4e7",
    backgroundColor: "#faf9f7",
  },
  tab: { flex: 1, alignItems: "center", paddingVertical: 12 },
  label: { fontSize: 14, color: "#a1a1aa", fontWeight: "500" },
  activeLabel: { color: "#1a1a1a", fontWeight: "700" },
});
