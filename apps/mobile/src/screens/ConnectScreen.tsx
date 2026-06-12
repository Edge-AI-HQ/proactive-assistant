/**
 * CONNECT 页——web DataConnections 的 RN 对应物（UI 刀 4）：
 * 双统计卡（DATA SOURCES n of 7 / DEVICES n paired）→ AMBIENT SOURCES
 * （Devices 卡）→ DATA SOURCES Recommended 折叠组（品牌 logo 走
 * logos.composio.dev，Google Workspace 子行缩进 + 账户标签列表，
 * Connected 绿点 / Connect 黑 pill）→ More data connectors 入口。
 */
import { useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import * as WebBrowser from "expo-web-browser";
import { ChevronDown, ChevronUp, Globe, Smartphone } from "lucide-react-native";
import { useQuery } from "@tanstack/react-query";
import {
  connectComposioToolkit,
  fetchComposioConnections,
  type ComposioConnection,
} from "@pin-ai/core";
import { useUserDevices } from "@pin-ai/state";

import PageHeader from "../components/app/PageHeader";
import { GlassCard } from "../ui/GlassCard";
import type { HeaderProps } from "./AmbientScreen";

interface SourceDef {
  name: string;
  toolkit: string;
  children?: { name: string; toolkit: string; note?: string }[];
}

// web RECOMMENDED_SOURCES 同构（7 顶级 + Google children）。
const RECOMMENDED: SourceDef[] = [
  {
    name: "Google Workspace",
    toolkit: "google",
    children: [
      { name: "Gmail", toolkit: "gmail" },
      { name: "Calendar", toolkit: "googlecalendar" },
      { name: "Drive", toolkit: "googledrive" },
      { name: "Docs", toolkit: "googledocs" },
      { name: "Sheets", toolkit: "googlesheets" },
      { name: "Slides", toolkit: "googledrive", note: "via Drive metadata" },
    ],
  },
  { name: "Slack", toolkit: "slack" },
  { name: "GitHub", toolkit: "github" },
  { name: "LinkedIn", toolkit: "linkedin" },
  { name: "Stripe", toolkit: "stripe" },
  { name: "YouTube", toolkit: "youtube" },
  { name: "Calendly", toolkit: "calendly" },
];

const logoUrl = (toolkit: string) => `https://logos.composio.dev/api/${toolkit}`;

function StatusPill({
  connected,
  connecting,
  onConnect,
}: {
  connected: boolean;
  connecting: boolean;
  onConnect: () => void;
}) {
  if (connected) {
    return (
      <View className="flex-row items-center gap-1.5">
        <View className="h-1.5 w-1.5 rounded-full bg-green-500" />
        <Text className="text-[12px] text-green-600" style={{ fontFamily: "Inter_500Medium" }}>
          Connected
        </Text>
      </View>
    );
  }
  return (
    <Pressable
      onPress={onConnect}
      disabled={connecting}
      className="rounded-full bg-foreground px-3.5 py-1.5"
      style={connecting ? { opacity: 0.5 } : undefined}
    >
      <Text className="text-[12px] text-white" style={{ fontFamily: "Inter_600SemiBold" }}>
        {connecting ? "Connecting…" : "Connect"}
      </Text>
    </Pressable>
  );
}

function SourceRow({
  def,
  depth,
  connections,
  connecting,
  onConnect,
}: {
  def: { name: string; toolkit: string; note?: string };
  depth: number;
  connections: ComposioConnection[];
  connecting: string | null;
  onConnect: (toolkit: string) => void;
}) {
  const matched = connections.filter(
    (c) => c.toolkit === def.toolkit && c.status === "ACTIVE",
  );
  const connected = matched.length > 0;
  return (
    <View>
      <View
        className="flex-row items-center gap-2.5 py-2.5"
        style={{ paddingLeft: depth * 18 }}
      >
        <Image
          source={{ uri: logoUrl(def.toolkit) }}
          style={{ width: 20, height: 20, borderRadius: 4 }}
        />
        <Text className="flex-1 text-[14px] text-foreground" style={{ fontFamily: "Inter_500Medium" }} numberOfLines={1}>
          {def.name}
          {def.note ? <Text className="text-[11px] text-muted-foreground">  {def.note}</Text> : null}
        </Text>
        <StatusPill
          connected={connected}
          connecting={connecting === def.toolkit}
          onConnect={() => onConnect(def.toolkit)}
        />
      </View>
      {matched.map((c) =>
        c.label ? (
          <Text
            key={c.connectedAccountId ?? c.label}
            className="text-[12px] text-muted-foreground py-0.5"
            style={{ paddingLeft: depth * 18 + 30 }}
          >
            {c.label}
          </Text>
        ) : null,
      )}
    </View>
  );
}

export default function ConnectScreen({ headerProps }: { headerProps: HeaderProps }) {
  const connectionsQuery = useQuery({
    queryKey: ["composio", "connections"],
    queryFn: ({ signal }) => fetchComposioConnections(signal),
    refetchInterval: 30_000,
  });
  const { devices } = useUserDevices();
  const [connecting, setConnecting] = useState<string | null>(null);
  const [recommendedOpen, setRecommendedOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const connections = connectionsQuery.data ?? [];
  const activeToolkits = new Set(
    connections.filter((c) => c.status === "ACTIVE").map((c) => c.toolkit),
  );
  const connectedTop = RECOMMENDED.filter((s) =>
    s.children
      ? s.children.some((c) => activeToolkits.has(c.toolkit))
      : activeToolkits.has(s.toolkit),
  ).length;
  const activeDevices = devices.filter((d) => d.status === "active");

  const connect = async (toolkit: string) => {
    setConnecting(toolkit);
    setError(null);
    try {
      const r = await connectComposioToolkit(toolkit);
      if (!r.ok) {
        setError(r.error ?? "Connect failed");
        return;
      }
      if (r.redirectUrl) await WebBrowser.openBrowserAsync(r.redirectUrl);
      await connectionsQuery.refetch();
    } finally {
      setConnecting(null);
    }
  };

  return (
    <View className="flex-1">
      <PageHeader title="Connect" subtitle="Data sources & devices powering your AI" {...headerProps} />
      <ScrollView className="flex-1 px-5" contentContainerClassName="pb-12">
        <View className="flex-row gap-3">
          <GlassCard className="flex-1 px-4 py-3.5">
            <Text className="text-[10px] tracking-[1.2px] text-muted-foreground" style={{ fontFamily: "Inter_600SemiBold" }}>
              DATA SOURCES
            </Text>
            <View className="mt-1 flex-row items-baseline gap-1">
              <Text className="text-[24px] text-foreground" style={{ fontFamily: "Inter_700Bold" }}>
                {connectedTop}
              </Text>
              <Text className="text-[14px] text-muted-foreground">of {RECOMMENDED.length}</Text>
            </View>
            <View className="mt-1 flex-row items-center gap-1.5">
              <View className="h-1.5 w-1.5 rounded-full bg-green-500" />
              <Text className="text-[11px] text-muted-foreground">All synced</Text>
            </View>
          </GlassCard>
          <GlassCard className="flex-1 px-4 py-3.5">
            <Text className="text-[10px] tracking-[1.2px] text-muted-foreground" style={{ fontFamily: "Inter_600SemiBold" }}>
              DEVICES
            </Text>
            <View className="mt-1 flex-row items-baseline gap-1">
              <Text className="text-[24px] text-foreground" style={{ fontFamily: "Inter_700Bold" }}>
                {activeDevices.length}
              </Text>
              <Text className="text-[14px] text-muted-foreground">paired</Text>
            </View>
            <View className="mt-1 flex-row items-center gap-1.5">
              <View className="h-1.5 w-1.5 rounded-full bg-green-500" />
              <Text className="text-[11px] text-muted-foreground">All synced</Text>
            </View>
          </GlassCard>
        </View>

        <Text className="mt-5 mb-2 text-[11px] tracking-[1.5px] text-pink-500" style={{ fontFamily: "Inter_600SemiBold" }}>
          · AMBIENT SOURCES
        </Text>
        <GlassCard strong className="flex-row items-center gap-3 px-4 py-3.5">
          <View className="h-9 w-9 items-center justify-center rounded-xl bg-pink-100">
            <Smartphone size={16} color="#ec4899" strokeWidth={1.8} />
          </View>
          <View className="flex-1">
            <View className="flex-row items-center gap-2">
              <Text className="text-[15px] text-foreground" style={{ fontFamily: "Inter_600SemiBold" }}>
                Devices
              </Text>
              <View className="rounded-full bg-pink-100 px-2 py-0.5">
                <Text className="text-[10px] text-pink-600" style={{ fontFamily: "Inter_600SemiBold" }}>
                  {activeDevices.length} active
                </Text>
              </View>
            </View>
            <Text className="mt-0.5 text-[12px] leading-4 text-muted-foreground">
              Phones, laptops, wearables, glasses, cameras — encrypted peer-to-peer
            </Text>
          </View>
        </GlassCard>
        {activeDevices.map((d) => (
          <View key={d.device_id} className="flex-row items-center gap-2.5 px-4 py-2">
            <View className="h-1.5 w-1.5 rounded-full bg-green-500" />
            <Text className="flex-1 text-[13px] text-foreground/80" numberOfLines={1}>
              {d.display_name ?? d.model ?? d.device_id}
            </Text>
            <Text className="text-[11px] text-muted-foreground">{d.platform}</Text>
          </View>
        ))}

        <Text className="mt-5 mb-2 text-[11px] tracking-[1.5px] text-muted-foreground" style={{ fontFamily: "Inter_600SemiBold" }}>
          · DATA SOURCES
        </Text>
        {error ? <Text className="mb-2 text-[12px] text-red-600">{error}</Text> : null}
        <GlassCard strong className="px-4 py-3">
          <Pressable
            onPress={() => setRecommendedOpen((v) => !v)}
            className="flex-row items-center gap-2"
          >
            <Text className="flex-1 text-[15px] text-foreground" style={{ fontFamily: "Inter_600SemiBold" }}>
              Recommended{"  "}
              <Text className="text-[12px] text-muted-foreground">
                {connectedTop} / {RECOMMENDED.length}
              </Text>
            </Text>
            {recommendedOpen ? (
              <ChevronUp size={16} color="#a1a1aa" />
            ) : (
              <ChevronDown size={16} color="#a1a1aa" />
            )}
          </Pressable>
          <Text className="text-[12px] text-muted-foreground">Best first-party data sources</Text>
          {recommendedOpen ? (
            <View className="mt-2">
              <Text className="mb-1 mt-1 text-[10px] tracking-[1.2px] text-muted-foreground" style={{ fontFamily: "Inter_600SemiBold" }}>
                · CORE SOURCES
              </Text>
              {connectionsQuery.isLoading ? (
                <ActivityIndicator color="#a1a1aa" style={{ marginVertical: 14 }} />
              ) : (
                RECOMMENDED.map((s) => (
                  <View key={s.name}>
                    <SourceRow
                      def={s}
                      depth={0}
                      connections={connections}
                      connecting={connecting}
                      onConnect={(tk) => void connect(tk)}
                    />
                    {s.children?.map((c) => (
                      <SourceRow
                        key={c.name}
                        def={c}
                        depth={1}
                        connections={connections}
                        connecting={connecting}
                        onConnect={(tk) => void connect(tk)}
                      />
                    ))}
                  </View>
                ))
              )}
            </View>
          ) : null}
        </GlassCard>

        <GlassCard className="mt-3 flex-row items-center gap-3 px-4 py-4">
          <View className="h-9 w-9 items-center justify-center rounded-xl bg-white/80 border border-white/70">
            <Globe size={16} color="#71717a" strokeWidth={1.8} />
          </View>
          <View className="flex-1">
            <Text className="text-[15px] text-foreground" style={{ fontFamily: "Inter_600SemiBold" }}>
              More data connectors
            </Text>
            <Text className="mt-0.5 text-[12px] text-muted-foreground">1000+ supported sources</Text>
          </View>
          <ChevronDown size={16} color="#a1a1aa" />
        </GlassCard>
      </ScrollView>
    </View>
  );
}
