/**
 * AMBIENT 页——web AmbientView 的 RN 对应物（UI 刀 5）：
 * 页头（N device(s) · on-device TEE，对齐 web AmbientView）→ 开关卡 → 设备 avatar 行 →
 * TODAY · SIGNALS 时间线（来源标签 + 标题 + 描述 + #kind tag）。
 * 数据源 = 服务端 personal signals（GET /api/signals——RN ingest 上去
 * 的同一批数据读回，与 web 本地 timeline store 等价的服务端真相）。
 * 叙事摘要（web 的 NARRATIVE SUMMARY 卡）依赖 timeline 汇总管道，
 * 该管道在 RN 落地后接入。
 */
import { type ReactNode, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Animated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import { Lock, Radio, Smartphone, Unlock } from "lucide-react-native";
import { useQuery } from "@tanstack/react-query";
import { fetchSignals } from "@pin-ai/core";
import { useUserDevices } from "@pin-ai/state";

import { GlassCard } from "../ui/GlassCard";
import PageHeader from "../components/app/PageHeader";
import { isAmbientEnabled, startAmbient, stopAmbient } from "../ambient/runtime";
import { isUploadsLocked, setUploadsLocked } from "../ambient/ingest";
import { EM_TIGHT, tracking } from "../ui/typography";

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

// web 副标题各段共用：bodySm(13) Inter_400 + 显式 lineHeight（RN 必写）。
const subtitlePartStyle = { fontFamily: "Inter_400Regular", lineHeight: 18 };

// --foreground / --background 通道值。NativeWind 的 hsl(var(--x)) 没有 <alpha-value>
// 槽，/opacity 修饰符不可靠 → 带透明度的色一律内联 hsla()，保证渲染。
const FG = "230, 25%, 15%";
const fg = (alpha?: number) => (alpha === undefined ? `hsl(${FG})` : `hsla(${FG}, ${alpha})`);
const BG = "hsl(220, 30%, 96%)";

export default function AmbientScreen({
  headerProps,
  userId,
}: {
  headerProps: HeaderProps;
  userId: string;
}) {
  const [on, setOn] = useState(false);
  const [locked, setLocked] = useState(false);
  const { devices } = useUserDevices();
  const activeDevices = devices.filter((d) => d.status === "active");
  // web AmbientView deviceCount：单复数化（"1 device" / "2 devices"）。
  const deviceCountLabel = `${activeDevices.length} ${activeDevices.length === 1 ? "device" : "devices"}`;

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

  // upload soft-lock：开时显示锁钮；锁上 = 暂停上传（继续本地采集）。持久化在 ingest。
  useEffect(() => {
    void isUploadsLocked().then(setLocked);
  }, []);
  const toggleLock = async () => {
    const next = !locked;
    setLocked(next);
    await setUploadsLocked(next);
  };

  return (
    <View className="flex-1">
      <PageHeader
        title={
          // web AmbientView h1：text-2xl(24) / font-semibold(600) / tracking-tight(-0.025em) / leading-tight(1.25→30)。
          <Text
            className="text-[24px] text-foreground"
            style={{ fontFamily: "Inter_600SemiBold", letterSpacing: tracking(24, EM_TIGHT), lineHeight: 30 }}
          >
            Ambient
          </Text>
        }
        subtitle={
          // web 副标题：bodySm(13) / foreground-60，中点 "·" foreground-30，段间 gap-1.5(6)。
          <View className="mt-1 flex-row items-center" style={{ gap: 6 }}>
            <Text className="text-[13px]" style={[subtitlePartStyle, { color: fg(0.6) }]}>
              {deviceCountLabel}
            </Text>
            <Text className="text-[13px]" style={[subtitlePartStyle, { color: fg(0.3) }]}>·</Text>
            <Text className="text-[13px]" style={[subtitlePartStyle, { color: fg(0.6) }]}>
              on-device TEE
            </Text>
          </View>
        }
        {...headerProps}
      />
      <ScrollView className="flex-1 px-4" contentContainerClassName="pb-12">
        {/* 开关卡（web AmbientView hero switch）：渐变玻璃 + 雷达图标 + 文案 + 锁 + 开关 */}
        <AmbientHeroCard on={on}>
          <View className="flex-1 flex-row items-center" style={{ gap: 12 }}>
            <AmbientStatusIcon on={on} />
            <View className="flex-1">
              <Text
                numberOfLines={1}
                className="text-[13px]"
                style={{ fontFamily: "Inter_600SemiBold", lineHeight: 16, color: fg() }}
              >
                {on ? "Ambient is on" : "Ambient is off"}
              </Text>
              <Text
                numberOfLines={1}
                className="mt-0.5 text-[11px]"
                style={{ fontFamily: "Inter_400Regular", lineHeight: 14, color: fg(0.55) }}
              >
                {!on
                  ? "AI is paused from sensing your surroundings"
                  : locked
                    ? "Sensing locally — uploads paused"
                    : "Listening, sensing, understanding context"}
              </Text>
            </View>
          </View>
          <View className="flex-row items-center" style={{ gap: 8 }}>
            {on ? <LockButton locked={locked} onPress={() => void toggleLock()} /> : null}
            <AmbientToggle on={on} onPress={() => void toggle(!on)} />
          </View>
        </AmbientHeroCard>

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

// ── web AmbientView hero switch 的自定义视觉（渐变玻璃卡 + 图标 + 锁 + 开关）──

/** 渐变玻璃卡（对齐 web hero：rounded-2xl(16) + blur(20) + 白渐变 0.4→0.25 / 0.7→0.4
 *  + border white/0.5 + on 态外影）。比 GlassCard strong 更透、圆角更小。 */
function AmbientHeroCard({ on, children }: { on: boolean; children: ReactNode }) {
  return (
    <View
      style={{
        marginTop: 12,
        borderRadius: 16,
        boxShadow: on ? "0 4px 24px hsla(0, 0%, 0%, 0.06)" : undefined,
      }}
    >
      <View style={[StyleSheet.absoluteFill, { borderRadius: 16, overflow: "hidden" }]} pointerEvents="none">
        <BlurView intensity={28} tint="light" style={StyleSheet.absoluteFill} />
        <LinearGradient
          colors={
            on
              ? ["rgba(255,255,255,0.7)", "rgba(255,255,255,0.4)"]
              : ["rgba(255,255,255,0.4)", "rgba(255,255,255,0.25)"]
          }
          start={{ x: 0, y: 0 }}
          end={{ x: 0, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <View
          style={[
            StyleSheet.absoluteFill,
            { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth * 2, borderColor: "rgba(255,255,255,0.5)" },
          ]}
        />
      </View>
      <View className="flex-row items-center justify-between px-4" style={{ paddingVertical: 18 }}>{children}</View>
    </View>
  );
}

/** upload 软锁钮（web w-9 h-9=36 圆 + border；锁=实心 foreground，开=极淡）。 */
function LockButton({ locked, onPress }: { locked: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={locked ? "Unlock uploads" : "Lock uploads"}
    >
      <View
        style={{
          width: 36,
          height: 36,
          borderRadius: 18,
          alignItems: "center",
          justifyContent: "center",
          borderWidth: 1,
          backgroundColor: locked ? fg() : fg(0.04),
          borderColor: locked ? fg() : fg(0.15),
        }}
      >
        {locked ? (
          <Lock size={14} strokeWidth={2.2} color={BG} />
        ) : (
          <Unlock size={14} strokeWidth={2.2} color={fg(0.6)} />
        )}
      </View>
    </Pressable>
  );
}

/** 雷达图标（web Radio 14 / 32 圆 + on 态 ping 脉冲 + 绿点）。圆底内联 hsla 保证渲染。 */
function AmbientStatusIcon({ on }: { on: boolean }) {
  return (
    <View style={{ width: 32, height: 32, alignItems: "center", justifyContent: "center" }}>
      {on ? <PingRing /> : null}
      <View
        style={{
          width: 32,
          height: 32,
          borderRadius: 16,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: on ? fg() : fg(0.1),
        }}
      >
        <Radio size={14} strokeWidth={2.2} color={on ? BG : fg(0.4)} />
      </View>
      {on ? (
        <View
          style={{
            position: "absolute",
            top: -1,
            right: -1,
            width: 10,
            height: 10,
            borderRadius: 5,
            backgroundColor: "#10b981",
            borderWidth: 2,
            borderColor: BG,
          }}
        />
      ) : null}
    </View>
  );
}

/** web Tailwind animate-ping 等价：1s 内 scale 1→2 + opacity 0.15→0（前 75% 扩散
 *  渐隐、后 25% 停在不可见再 snap 回，形成"雷达 blip"节奏），bezier(0,0,.2,1)。
 *  底色用 fg() 满不透明，由动画 opacity 控到峰值 15%（= web bg-foreground/15）。 */
function PingRing() {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withRepeat(
      withTiming(1, { duration: 1000, easing: Easing.bezier(0, 0, 0.2, 1) }),
      -1,
      false,
    );
  }, [t]);
  const style = useAnimatedStyle(() => ({
    transform: [{ scale: interpolate(t.value, [0, 0.75, 1], [1, 2, 2]) }],
    opacity: interpolate(t.value, [0, 0.75, 1], [0.15, 0, 0]),
  }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        { position: "absolute", width: 32, height: 32, borderRadius: 16, backgroundColor: fg() },
        style,
      ]}
    />
  );
}

/** 自定义开关（web w-12 h-7 = 48×28 + 24 拇指，spring 500/35），替原生 Switch。 */
function AmbientToggle({ on, onPress }: { on: boolean; onPress: () => void }) {
  const x = useSharedValue(on ? 20 : 0);
  useEffect(() => {
    x.value = withSpring(on ? 20 : 0, { stiffness: 500, damping: 35 });
  }, [on, x]);
  const thumbStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  return (
    <Pressable onPress={onPress} hitSlop={8} accessibilityRole="switch" accessibilityState={{ checked: on }}>
      <View
        style={{
          width: 48,
          height: 28,
          borderRadius: 14,
          justifyContent: "center",
          backgroundColor: on ? fg() : fg(0.2),
        }}
      >
        <Animated.View
          style={[
            {
              position: "absolute",
              left: 2,
              width: 24,
              height: 24,
              borderRadius: 12,
              backgroundColor: BG,
              shadowColor: "#000",
              shadowOpacity: 0.12,
              shadowRadius: 3,
              shadowOffset: { width: 0, height: 1 },
            },
            thumbStyle,
          ]}
        />
      </View>
    </Pressable>
  );
}
