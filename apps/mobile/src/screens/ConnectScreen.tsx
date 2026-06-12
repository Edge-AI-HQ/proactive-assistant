/**
 * Connect 视图：Composio connector 连接状态 + 发起 OAuth（系统浏览器面板，
 * 回归后刷新）+ 设备列表。协议层全部来自 core（与 web 的 useComposio
 * 同一后端面）。
 */
import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as WebBrowser from "expo-web-browser";
import { useQuery } from "@tanstack/react-query";
import {
  connectComposioToolkit,
  fetchComposioConnections,
  type ComposioConnection,
} from "@pin-ai/core";
import { useUserDevices } from "@pin-ai/state";

const SUGGESTED_TOOLKITS = [
  "gmail",
  "googlecalendar",
  "github",
  "notion",
  "slack",
  "linear",
];

function ConnectionRow({ conn }: { conn: ComposioConnection }) {
  const active = conn.status === "ACTIVE";
  return (
    <View style={styles.row}>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle}>{conn.toolkit}</Text>
        {conn.label ? <Text style={styles.rowMeta}>{conn.label}</Text> : null}
      </View>
      <Text style={[styles.status, { color: active ? "#16a34a" : "#ca8a04" }]}>
        {active ? "Connected" : conn.status.toLowerCase()}
      </Text>
    </View>
  );
}

export default function ConnectScreen() {
  const connections = useQuery({
    queryKey: ["composio", "connections"],
    queryFn: ({ signal }) => fetchComposioConnections(signal),
    refetchInterval: 30_000,
  });
  const { devices } = useUserDevices();
  const [connecting, setConnecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const connectedToolkits = new Set(
    (connections.data ?? []).filter((c) => c.status === "ACTIVE").map((c) => c.toolkit),
  );
  const suggestions = SUGGESTED_TOOLKITS.filter((t) => !connectedToolkits.has(t));

  const connect = async (toolkit: string) => {
    setConnecting(toolkit);
    setError(null);
    try {
      const r = await connectComposioToolkit(toolkit);
      if (!r.ok) {
        setError(r.error ?? "Connect failed");
        return;
      }
      if (r.redirectUrl) {
        // OAuth 在系统浏览器面板完成；关闭面板后刷新连接状态。
        await WebBrowser.openBrowserAsync(r.redirectUrl);
      }
      await connections.refetch();
    } finally {
      setConnecting(null);
    }
  };

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Text style={styles.section}>Connected</Text>
      {connections.isLoading ? (
        <ActivityIndicator color="#71717a" style={{ marginVertical: 16 }} />
      ) : (connections.data ?? []).length === 0 ? (
        <Text style={styles.empty}>Nothing connected yet.</Text>
      ) : (
        (connections.data ?? []).map((c, i) => (
          <ConnectionRow key={c.connectedAccountId ?? `${c.toolkit}-${i}`} conn={c} />
        ))
      )}

      {suggestions.length > 0 ? (
        <>
          <Text style={styles.section}>Add a connector</Text>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <View style={styles.grid}>
            {suggestions.map((t) => (
              <Pressable
                key={t}
                style={[styles.connectButton, connecting === t && { opacity: 0.5 }]}
                disabled={connecting !== null}
                onPress={() => void connect(t)}
              >
                <Text style={styles.connectText}>
                  {connecting === t ? "Connecting…" : t}
                </Text>
              </Pressable>
            ))}
          </View>
        </>
      ) : null}

      <Text style={styles.section}>Devices</Text>
      {devices.map((d) => (
        <View key={d.device_id} style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={styles.rowTitle}>{d.display_name ?? d.model ?? d.device_id}</Text>
            <Text style={styles.rowMeta}>{d.platform}</Text>
          </View>
          <Text style={[styles.status, { color: d.status === "active" ? "#16a34a" : "#a1a1aa" }]}>
            {d.status}
          </Text>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 16, paddingBottom: 32 },
  section: {
    fontSize: 13,
    fontWeight: "600",
    color: "#71717a",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 20,
    marginBottom: 8,
  },
  empty: { color: "#a1a1aa", fontSize: 14, marginVertical: 8 },
  error: { color: "#dc2626", fontSize: 13, marginBottom: 8 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 8,
  },
  rowTitle: { fontSize: 15, fontWeight: "500", color: "#1a1a1a", textTransform: "capitalize" },
  rowMeta: { fontSize: 12, color: "#a1a1aa", marginTop: 2 },
  status: { fontSize: 12, fontWeight: "600" },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  connectButton: {
    backgroundColor: "#1a1a1a",
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  connectText: { color: "#fff", fontSize: 14, fontWeight: "500", textTransform: "capitalize" },
});
