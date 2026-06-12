/**
 * Me 视图：账号信息 + agent 记忆（@pin-ai/state useMemories 只读）+
 * Sign out。设置细项（语言/自动生成/订阅）随后续刀展开。
 */
import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import type { User } from "@supabase/supabase-js";
import { useMemories } from "@pin-ai/state";

import { isAmbientEnabled, startAmbient, stopAmbient } from "../ambient/runtime";

export default function MeScreen({
  user,
  onSignOut,
}: {
  user: User;
  onSignOut: () => Promise<void>;
}) {
  const { memories, total, loading } = useMemories(true);
  const [ambientOn, setAmbientOn] = useState(false);

  useEffect(() => {
    void isAmbientEnabled().then(setAmbientOn);
  }, []);

  const toggleAmbient = async (next: boolean) => {
    setAmbientOn(next);
    if (next) {
      const started = await startAmbient(user.id);
      if (started.length === 0) setAmbientOn(false); // 全部权限被拒
    } else {
      await stopAmbient();
    }
  };

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <Text style={styles.email}>{user.email ?? user.id}</Text>
        <Text style={styles.meta}>PIN AI Dev · React Native</Text>
      </View>

      <Text style={styles.section}>Ambient sensing</Text>
      <View style={styles.row}>
        <View style={{ flex: 1 }}>
          <Text style={styles.rowTitle}>Collect device signals</Text>
          <Text style={styles.rowMeta}>Location · visits · motion · audio · calendar · health · device state</Text>
        </View>
        <Switch value={ambientOn} onValueChange={(v) => void toggleAmbient(v)} />
      </View>

      <Text style={styles.section}>What PIN AI remembers ({total})</Text>
      {loading ? (
        <Text style={styles.empty}>Loading…</Text>
      ) : memories.length === 0 ? (
        <Text style={styles.empty}>No memories yet — keep chatting.</Text>
      ) : (
        memories.slice(0, 30).map((m) => (
          <View key={m.id} style={styles.memoryRow}>
            <Text style={styles.memoryText}>{m.text}</Text>
            <Text style={styles.memoryMeta}>
              {m.subject ?? m.source} · q{Math.round(m.quality * 10) / 10}
            </Text>
          </View>
        ))
      )}

      <Pressable style={styles.signOut} onPress={() => void onSignOut()}>
        <Text style={styles.signOutText}>Sign out</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#f6f4f0" },
  content: { padding: 16, paddingBottom: 40 },
  card: { backgroundColor: "#fff", borderRadius: 16, padding: 16 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  rowTitle: { fontSize: 15, fontWeight: "500", color: "#1a1a1a" },
  rowMeta: { fontSize: 12, color: "#a1a1aa", marginTop: 2 },
  email: { fontSize: 16, fontWeight: "600", color: "#1a1a1a" },
  meta: { fontSize: 12, color: "#a1a1aa", marginTop: 4 },
  section: {
    fontSize: 13,
    fontWeight: "600",
    color: "#71717a",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 24,
    marginBottom: 8,
  },
  empty: { color: "#a1a1aa", fontSize: 14, marginVertical: 8 },
  memoryRow: {
    backgroundColor: "#fff",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 6,
  },
  memoryText: { fontSize: 14, color: "#1a1a1a", lineHeight: 19 },
  memoryMeta: { fontSize: 11, color: "#a1a1aa", marginTop: 4 },
  signOut: {
    marginTop: 32,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: "center",
    backgroundColor: "#fee2e2",
  },
  signOutText: { color: "#dc2626", fontSize: 15, fontWeight: "600" },
});
