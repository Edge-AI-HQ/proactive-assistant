/**
 * AMBIENT 页——web AmbientView 的 RN 对应物（UI 刀 5）：
 * 页头（N devices · on-device sensing）→ 开关卡 → 设备 avatar 行 →
 * TODAY · SIGNALS 时间线（来源标签 + 标题 + 描述 + #kind tag）。
 * 数据源 = 服务端 personal signals（GET /api/signals——RN ingest 上去
 * 的同一批数据读回，与 web 本地 timeline store 等价的服务端真相）。
 * 叙事摘要（web 的 NARRATIVE SUMMARY 卡）依赖 timeline 汇总管道，
 * 该管道在 RN 落地后接入。
 */
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  Switch,
  Text,
  View,
} from "react-native";
import { Smartphone } from "lucide-react-native";
import { useQuery } from "@tanstack/react-query";
import { fetchSignals } from "@pin-ai/core";
import { useUserDevices } from "@pin-ai/state";

import { GlassCard } from "../ui/GlassCard";
import PageHeader from "../components/app/PageHeader";
import { isAmbientEnabled, startAmbient, stopAmbient } from "../ambient/runtime";

export interface HeaderProps {
  onOpenDebug: () => void;
  onOpenMenu: () => void;
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** kind → 短标签（device.location → location）。 */
function kindTag(kind: string): string {
  return kind.split(".").pop() ?? kind;
}

export default function AmbientScreen({
  headerProps,
  userId,
}: {
  headerProps: HeaderProps;
  userId: string;
}) {
  const [on, setOn] = useState(false);
  const { devices } = useUserDevices();
  const activeDevices = devices.filter((d) => d.status === "active");

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const signalsQuery = useQuery({
    queryKey: ["ambient", "signals", startOfDay.toDateString()],
    queryFn: ({ signal }) =>
      fetchSignals(
        { status: "all", since: startOfDay.toISOString(), limit: 50 },
        signal,
      ),
    refetchInterval: 60_000,
  });
  const signals = signalsQuery.data?.signals ?? [];

  useEffect(() => {
    void isAmbientEnabled().then(setOn);
  }, []);

  const toggle = async (next: boolean) => {
    setOn(next);
    if (next) {
      const started = await startAmbient(userId);
      if (started.length === 0) setOn(false);
    } else {
      await stopAmbient();
    }
  };

  return (
    <View className="flex-1">
      <PageHeader
        title="Ambient"
        subtitle={`${activeDevices.length} devices · on-device sensing`}
        {...headerProps}
      />
      <ScrollView className="flex-1 px-5" contentContainerClassName="pb-12">
        {/* 开关卡 */}
        <GlassCard strong className="mt-1 flex-row items-center px-4 py-4">
          <View className="flex-1">
            <Text className="text-[15px] text-foreground" style={{ fontFamily: "Inter_600SemiBold" }}>
              {on ? "Ambient is on" : "Ambient is off"}
            </Text>
            <Text className="mt-0.5 text-[12px] text-muted-foreground" style={{ fontFamily: "Inter_400Regular" }}>
              {on ? "AI is sensing your surroundings" : "AI is paused from sensing your surroundings"}
            </Text>
          </View>
          <Switch value={on} onValueChange={(v) => void toggle(v)} />
        </GlassCard>

        {/* 设备行 */}
        <GlassCard className="mt-3 flex-row items-center gap-3 px-4 py-3">
          <View className="flex-row">
            {activeDevices.slice(0, 3).map((d, i) => (
              <View
                key={d.device_id}
                className="h-8 w-8 items-center justify-center rounded-full bg-white border border-white/80"
                style={{ marginLeft: i > 0 ? -8 : 0 }}
              >
                <Smartphone size={13} color="#71717a" strokeWidth={1.8} />
              </View>
            ))}
          </View>
          <View className="flex-1" />
          <View className="items-end">
            <Text className="text-[13px] text-foreground" style={{ fontFamily: "Inter_600SemiBold" }}>
              Manage devices
            </Text>
            <Text className="text-[11px] text-muted-foreground">Connect in Control ›</Text>
          </View>
        </GlassCard>

        {/* TODAY 时间线 */}
        <View className="mt-5 flex-row items-center">
          <Text className="flex-1 text-[11px] tracking-[1.5px] text-pink-500" style={{ fontFamily: "Inter_600SemiBold" }}>
            ✦ TODAY · SIGNALS
          </Text>
          <Text className="text-[11px] text-muted-foreground" style={{ fontFamily: "Inter_400Regular" }}>
            {signals.length} entries
          </Text>
        </View>

        {signalsQuery.isLoading ? (
          <ActivityIndicator color="#a1a1aa" style={{ marginTop: 24 }} />
        ) : signals.length === 0 ? (
          <Text className="mt-6 text-center text-[13px] text-muted-foreground" style={{ fontFamily: "Inter_400Regular" }}>
            {on
              ? "Listening — signals will appear here as your day unfolds."
              : "Turn on ambient sensing to start building today's timeline."}
          </Text>
        ) : (
          signals.map((s) => (
            <GlassCard key={s.id} className="mt-2.5 px-4 py-3.5">
              <View className="flex-row items-center gap-2">
                <Text className="text-[11px] text-muted-foreground" style={{ fontFamily: "Inter_500Medium" }}>
                  {timeLabel(s.occurred_at)}
                </Text>
                <Text className="text-[11px] text-muted-foreground">·</Text>
                <View className="flex-row items-center gap-1">
                  <Smartphone size={10} color="#a1a1aa" strokeWidth={1.8} />
                  <Text className="text-[11px] text-muted-foreground" style={{ fontFamily: "Inter_500Medium" }}>
                    {s.source?.startsWith("device:") ? "iPhone" : (s.source ?? "device")}
                  </Text>
                </View>
              </View>
              <Text className="mt-1.5 text-[15px] text-foreground" style={{ fontFamily: "Inter_600SemiBold" }}>
                {s.title}
              </Text>
              {s.summary ? (
                <Text className="mt-1 text-[13px] leading-5 text-foreground/70" style={{ fontFamily: "Inter_400Regular" }}>
                  {s.summary}
                </Text>
              ) : null}
              <View className="mt-2 flex-row gap-1.5">
                <View className="rounded-full bg-white/80 border border-white/70 px-2 py-0.5">
                  <Text className="text-[10px] text-muted-foreground" style={{ fontFamily: "Inter_500Medium" }}>
                    #{kindTag(s.kind)}
                  </Text>
                </View>
              </View>
            </GlassCard>
          ))
        )}
      </ScrollView>
    </View>
  );
}
