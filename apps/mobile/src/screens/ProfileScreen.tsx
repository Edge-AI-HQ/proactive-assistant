/**
 * PROFILE 页——web GoalsView 的 RN 对应物（UI 刀 6）：
 * Identity/Goals 双 tab（黑胶囊）→ IDENTITY 卡（display_name + AI
 * summary）→ PROFILE/MEMORY 双统计卡（点击切面板）→ Profile 面板 =
 * Facts/Preferences/Constraints 折叠组；Memory 面板 = 记忆列表；
 * Goals tab = 目标卡列表。数据 = core fetchProfileSnapshot + state
 * useMemories（与 web 同源）。
 */
import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { ChevronDown, ChevronUp } from "lucide-react-native";
import { useQuery } from "@tanstack/react-query";
import { fetchProfileSnapshot } from "@pin-ai/core";
import { useMemories } from "@pin-ai/state";

import { GlassCard } from "../ui/GlassCard";
import PageHeader from "../components/app/PageHeader";
import type { HeaderProps } from "./AmbientScreen";

function Collapsible({
  title,
  count,
  subtitle,
  entries,
}: {
  title: string;
  count: number;
  subtitle: string;
  entries: [string, unknown][];
}) {
  const [open, setOpen] = useState(false);
  return (
    <GlassCard className="mb-2 px-4 py-3">
      <Pressable onPress={() => setOpen((v) => !v)} className="flex-row items-center gap-2">
        <Text className="text-[15px] text-foreground" style={{ fontFamily: "Inter_600SemiBold" }}>
          {title}
        </Text>
        <View className="rounded-full bg-white/80 border border-white/70 px-2 py-0.5">
          <Text className="text-[10px] text-muted-foreground" style={{ fontFamily: "Inter_600SemiBold" }}>
            {count}
          </Text>
        </View>
        <View className="flex-1" />
        {open ? <ChevronUp size={15} color="#a1a1aa" /> : <ChevronDown size={15} color="#a1a1aa" />}
      </Pressable>
      <Text className="mt-0.5 text-[12px] text-muted-foreground" style={{ fontFamily: "Inter_400Regular" }}>
        {subtitle}
      </Text>
      {open
        ? entries.map(([key, value]) => (
            <View key={key} className="mt-2 border-t border-black/5 pt-2">
              <Text className="text-[11px] tracking-[0.5px] text-muted-foreground" style={{ fontFamily: "Inter_600SemiBold" }}>
                {key}
              </Text>
              <Text className="mt-0.5 text-[13px] leading-5 text-foreground/85" style={{ fontFamily: "Inter_400Regular" }}>
                {typeof value === "string" ? value : JSON.stringify(value)}
              </Text>
            </View>
          ))
        : null}
    </GlassCard>
  );
}

export default function ProfileScreen({ headerProps }: { headerProps: HeaderProps }) {
  const [tab, setTab] = useState<"identity" | "goals">("identity");
  const [panel, setPanel] = useState<"profile" | "memory">("profile");
  const snapshot = useQuery({
    queryKey: ["profile", "snapshot"],
    queryFn: ({ signal }) => fetchProfileSnapshot(signal),
    staleTime: 60_000,
  });
  const { memories, total: memoryTotal, loading: memoriesLoading } = useMemories(true);

  const profile = snapshot.data?.profile ?? null;
  const goals = snapshot.data?.goals ?? [];
  const facts = Object.entries(profile?.facts ?? {});
  const preferences = Object.entries(profile?.preferences ?? {});
  const constraints = Object.entries(profile?.constraints ?? {});

  return (
    <View className="flex-1">
      <PageHeader
        title="Profile"
        subtitle="Who your AI thinks you are — derived from your data."
        {...headerProps}
      />
      <ScrollView className="flex-1 px-5" contentContainerClassName="pb-12">
        {/* Identity / Goals 双 tab（黑胶囊） */}
        <GlassCard className="flex-row p-1">
          {(["identity", "goals"] as const).map((t) => (
            <Pressable
              key={t}
              onPress={() => setTab(t)}
              className={
                tab === t
                  ? "flex-1 items-center rounded-3xl bg-foreground py-2.5"
                  : "flex-1 items-center rounded-3xl py-2.5"
              }
            >
              <Text
                className={tab === t ? "text-[14px] text-white" : "text-[14px] text-muted-foreground"}
                style={{ fontFamily: "Inter_600SemiBold" }}
              >
                {t === "identity" ? "Identity" : "Goals"}
              </Text>
            </Pressable>
          ))}
        </GlassCard>

        {snapshot.isLoading ? (
          <ActivityIndicator color="#a1a1aa" style={{ marginTop: 40 }} />
        ) : tab === "identity" ? (
          <>
            {/* IDENTITY 卡 */}
            <GlassCard strong className="mt-3 px-4 py-4">
              <Text className="text-[10px] tracking-[1.5px] text-muted-foreground" style={{ fontFamily: "Inter_600SemiBold" }}>
                IDENTITY
              </Text>
              <Text className="mt-1.5 text-[20px] text-foreground" style={{ fontFamily: "Inter_700Bold" }}>
                {profile?.display_name ?? "—"}
              </Text>
              {profile?.summary ? (
                <Text className="mt-2 text-[13px] leading-5 text-foreground/75" style={{ fontFamily: "Inter_400Regular" }}>
                  {profile.summary}
                </Text>
              ) : null}
            </GlassCard>

            {/* PROFILE / MEMORY 统计卡（切面板） */}
            <View className="mt-3 flex-row gap-3">
              <Pressable className="flex-1" onPress={() => setPanel("profile")}>
                <View
                  className={
                    panel === "profile"
                      ? "rounded-3xl bg-foreground px-4 py-3.5"
                      : "rounded-3xl bg-white/55 border border-white/60 px-4 py-3.5"
                  }
                >
                  <Text
                    className={panel === "profile" ? "text-[10px] tracking-[1.2px] text-white/60" : "text-[10px] tracking-[1.2px] text-muted-foreground"}
                    style={{ fontFamily: "Inter_600SemiBold" }}
                  >
                    PROFILE
                  </Text>
                  <Text
                    className={panel === "profile" ? "mt-1 text-[17px] text-white" : "mt-1 text-[17px] text-foreground"}
                    style={{ fontFamily: "Inter_700Bold" }}
                  >
                    Profile
                  </Text>
                </View>
              </Pressable>
              <Pressable className="flex-1" onPress={() => setPanel("memory")}>
                <View
                  className={
                    panel === "memory"
                      ? "rounded-3xl bg-foreground px-4 py-3.5"
                      : "rounded-3xl bg-white/55 border border-white/60 px-4 py-3.5"
                  }
                >
                  <Text
                    className={panel === "memory" ? "text-[10px] tracking-[1.2px] text-white/60" : "text-[10px] tracking-[1.2px] text-muted-foreground"}
                    style={{ fontFamily: "Inter_600SemiBold" }}
                  >
                    MEMORY
                  </Text>
                  <Text
                    className={panel === "memory" ? "mt-1 text-[17px] text-white" : "mt-1 text-[17px] text-foreground"}
                    style={{ fontFamily: "Inter_700Bold" }}
                  >
                    {memoryTotal}
                  </Text>
                </View>
              </Pressable>
            </View>

            {panel === "profile" ? (
              <View className="mt-3">
                <GlassCard strong className="mb-2 px-4 py-3">
                  <Text className="text-[15px] text-foreground" style={{ fontFamily: "Inter_600SemiBold" }}>
                    Profile
                  </Text>
                  <Text className="mt-0.5 text-[12px] text-muted-foreground" style={{ fontFamily: "Inter_400Regular" }}>
                    Facts, preferences, constraints, and metadata — derived from your data.
                  </Text>
                </GlassCard>
                <Collapsible title="Facts" count={facts.length} subtitle="Stable details the assistant knows about you." entries={facts} />
                <Collapsible title="Preferences" count={preferences.length} subtitle="How you prefer the assistant to behave." entries={preferences} />
                <Collapsible title="Constraints" count={constraints.length} subtitle="Rules and boundaries the assistant should honor." entries={constraints} />
              </View>
            ) : (
              <View className="mt-3">
                {memoriesLoading ? (
                  <ActivityIndicator color="#a1a1aa" style={{ marginTop: 20 }} />
                ) : (
                  memories.slice(0, 50).map((m) => (
                    <GlassCard key={m.id} className="mb-2 px-4 py-3">
                      <Text className="text-[13px] leading-5 text-foreground/90" style={{ fontFamily: "Inter_400Regular" }}>
                        {m.text}
                      </Text>
                      <Text className="mt-1 text-[10px] text-muted-foreground" style={{ fontFamily: "Inter_400Regular" }}>
                        {m.subject ?? m.source}
                      </Text>
                    </GlassCard>
                  ))
                )}
              </View>
            )}
          </>
        ) : (
          <View className="mt-3">
            {goals.length === 0 ? (
              <Text className="mt-8 text-center text-[13px] text-muted-foreground" style={{ fontFamily: "Inter_400Regular" }}>
                No goals yet — they emerge as PIN AI learns your priorities.
              </Text>
            ) : (
              goals.map((g) => (
                <GlassCard key={g.id} className="mb-2 px-4 py-3.5">
                  <Text className="text-[15px] text-foreground" style={{ fontFamily: "Inter_600SemiBold" }}>
                    {g.title}
                  </Text>
                  {g.summary ? (
                    <Text className="mt-1 text-[13px] leading-5 text-foreground/70" style={{ fontFamily: "Inter_400Regular" }}>
                      {g.summary}
                    </Text>
                  ) : null}
                  <Text className="mt-1.5 text-[10px] tracking-[1px] text-muted-foreground" style={{ fontFamily: "Inter_600SemiBold" }}>
                    {g.priority.toUpperCase()} · {g.status.toUpperCase()}
                  </Text>
                </GlassCard>
              ))
            )}
          </View>
        )}
      </ScrollView>
    </View>
  );
}
