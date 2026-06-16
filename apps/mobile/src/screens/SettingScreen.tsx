/**
 * SETTING 页——web AccountPanel 的 RN 对应物（UI 刀 7）：
 * 账号卡（avatar 圈 + 名 + email + Sign out pill）→ 四子页行
 * （Subscription & Billing[PRO 徽] / Preferences / Push Notifications /
 * Ambient）→ 子页内联导航（返回箭头）。
 * Subscription 子页 = plan 状态 + checkout 跳系统浏览器（Stripe 表单
 * dev 期走 web checkout 链接——RN 内嵌 Stripe Elements 不可复用，上线
 * 前按审核政策定稿）；Preferences = 语言 + auto-generate/dreaming/
 * crystallize 开关；Notifications = notifyNewCards；Ambient = per-source
 * consents（useUserSettings.patch，与 web 同协议）。
 */
import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Switch,
  Text,
  View,
} from "react-native";
import {
  ArrowLeft,
  Bell,
  ChevronRight,
  Radio,
  Settings2,
  Sparkles,
} from "lucide-react-native";
import { useQuery } from "@tanstack/react-query";
import type { User } from "@supabase/supabase-js";
import {
  GENERATION_LANGUAGE_OPTIONS,
  getCurrentSubscription,
  type SupportedGenerationLanguage,
} from "@pin-ai/core";
import { useUserSettings } from "@pin-ai/state";

import { GlassCard } from "../ui/GlassCard";
import PageHeader from "../components/app/PageHeader";
import type { HeaderProps } from "./AmbientScreen";

type SubPage = "main" | "subscription" | "preferences" | "notifications" | "ambient";

function SettingRow({
  Icon,
  title,
  subtitle,
  badge,
  onPress,
}: {
  Icon: typeof Bell;
  title: string;
  subtitle: string;
  badge?: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
    >
      <GlassCard className="mb-2.5 flex-row items-center gap-3 px-4 py-3.5">
        <View className="h-9 w-9 items-center justify-center rounded-full bg-white/85 border border-white/70">
          <Icon size={15} color="#71717a" strokeWidth={1.8} />
        </View>
        <View className="flex-1">
          <Text className="text-[15px] text-foreground" style={{ fontFamily: "Inter_600SemiBold" }}>
            {title}
          </Text>
          <Text className="mt-0.5 text-[12px] text-muted-foreground" style={{ fontFamily: "Inter_400Regular" }}>
            {subtitle}
          </Text>
        </View>
        {badge ? (
          <View className="rounded-full bg-pink-100 px-2 py-0.5">
            <Text className="text-[10px] text-pink-600" style={{ fontFamily: "Inter_700Bold" }}>
              {badge}
            </Text>
          </View>
        ) : null}
        <ChevronRight size={16} color="#a1a1aa" />
      </GlassCard>
    </Pressable>
  );
}

function ToggleRow({
  title,
  subtitle,
  value,
  onChange,
}: {
  title: string;
  subtitle?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <GlassCard className="mb-2 flex-row items-center px-4 py-3.5">
      <View className="flex-1">
        <Text className="text-[14px] text-foreground" style={{ fontFamily: "Inter_500Medium" }}>
          {title}
        </Text>
        {subtitle ? (
          <Text className="mt-0.5 text-[12px] text-muted-foreground" style={{ fontFamily: "Inter_400Regular" }}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      <Switch value={value} onValueChange={onChange} />
    </GlassCard>
  );
}

function SubHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <View className="flex-row items-center gap-3 px-6 pt-4 pb-2">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Back from ${title}`}
        onPress={onBack}
        hitSlop={8}
        className="h-10 w-10 items-center justify-center rounded-full bg-white/70 border border-white/60"
      >
        <ArrowLeft size={17} color="#3f3f46" strokeWidth={1.8} />
      </Pressable>
      <Text className="text-[22px] text-foreground" style={{ fontFamily: "Inter_700Bold" }}>
        {title}
      </Text>
    </View>
  );
}

export default function SettingScreen({
  headerProps,
  user,
  onSignOut,
}: {
  headerProps: HeaderProps;
  user: User;
  onSignOut: () => Promise<void>;
}) {
  const [page, setPage] = useState<SubPage>("main");
  const { settings, patch } = useUserSettings(user.id ?? null);
  const subscription = useQuery({
    queryKey: ["payment", "subscription"],
    queryFn: () => getCurrentSubscription(),
    staleTime: 60_000,
  });

  const planCode = subscription.data?.planCode ?? "free";
  const displayName =
    (user.user_metadata?.full_name as string | undefined) ?? user.email ?? user.id;
  const initial = (displayName[0] ?? "?").toUpperCase();

  if (page !== "main") {
    const titles: Record<Exclude<SubPage, "main">, string> = {
      subscription: "Subscription & Billing",
      preferences: "Preferences",
      notifications: "Push Notifications",
      ambient: "Ambient",
    };
    return (
      <View className="flex-1">
        <SubHeader title={titles[page]} onBack={() => setPage("main")} />
        <ScrollView className="flex-1 px-5" contentContainerClassName="pb-12 pt-2">
          {page === "subscription" ? (
            <>
              <GlassCard strong className="px-4 py-4">
                <Text className="text-[10px] tracking-[1.5px] text-muted-foreground" style={{ fontFamily: "Inter_600SemiBold" }}>
                  CURRENT PLAN
                </Text>
                <Text className="mt-1 text-[24px] text-foreground" style={{ fontFamily: "Inter_700Bold" }}>
                  {planCode.toUpperCase()}
                </Text>
                {subscription.data?.status ? (
                  <Text className="mt-0.5 text-[12px] text-muted-foreground" style={{ fontFamily: "Inter_400Regular" }}>
                    {subscription.data.status}
                  </Text>
                ) : null}
              </GlassCard>
              <Text className="mt-3 text-[12px] leading-5 text-muted-foreground" style={{ fontFamily: "Inter_400Regular" }}>
                Plan changes and payment management are handled on the web app
                during the dev period.
              </Text>
            </>
          ) : null}

          {page === "preferences" && settings ? (
            <>
              <Text className="mb-2 text-[11px] tracking-[1.5px] text-muted-foreground" style={{ fontFamily: "Inter_600SemiBold" }}>
                GENERATION LANGUAGE
              </Text>
              <GlassCard className="mb-4 px-2 py-2">
                {GENERATION_LANGUAGE_OPTIONS.map((opt) => (
                  <Pressable
                    key={opt.value}
                    onPress={() => void patch({ generationLanguage: opt.value as SupportedGenerationLanguage })}
                    className="flex-row items-center justify-between px-2 py-2.5"
                  >
                    <Text className="text-[14px] text-foreground" style={{ fontFamily: "Inter_500Medium" }}>
                      {opt.label}
                    </Text>
                    {settings.generationLanguage === opt.value ? (
                      <View className="h-2 w-2 rounded-full bg-foreground" />
                    ) : null}
                  </Pressable>
                ))}
              </GlassCard>
              <Text className="mb-2 text-[11px] tracking-[1.5px] text-muted-foreground" style={{ fontFamily: "Inter_600SemiBold" }}>
                AUTOMATION
              </Text>
              <ToggleRow
                title="Auto-generate cards"
                subtitle="Proactively draft new cards from your signals"
                value={settings.autoGenerate}
                onChange={(v) => void patch({ autoGenerate: v })}
              />
              <ToggleRow
                title="Auto-dreaming"
                subtitle="Background reflection over your day"
                value={settings.autoDreaming}
                onChange={(v) => void patch({ autoDreaming: v })}
              />
              <ToggleRow
                title="Auto-crystallize"
                subtitle="Distill long chats into memory"
                value={settings.autoCrystallize}
                onChange={(v) => void patch({ autoCrystallize: v })}
              />
            </>
          ) : null}

          {page === "notifications" && settings ? (
            <ToggleRow
              title="New card notifications"
              subtitle="Push when PIN AI prepares a new card — even during quiet hours"
              value={settings.notifyNewCards}
              onChange={(v) => void patch({ notifyNewCards: v })}
            />
          ) : null}

          {page === "ambient" && settings ? (
            <>
              <Text className="mb-2 text-[11px] tracking-[1.5px] text-muted-foreground" style={{ fontFamily: "Inter_600SemiBold" }}>
                SOURCE CONSENTS
              </Text>
              {Object.entries(settings.ambientSources ?? {}).length === 0 ? (
                <Text className="text-[13px] text-muted-foreground" style={{ fontFamily: "Inter_400Regular" }}>
                  No source consents yet — turn on Ambient from the NOW page.
                </Text>
              ) : (
                Object.entries(settings.ambientSources ?? {}).map(([key, consent]) => (
                  <ToggleRow
                    key={key}
                    title={key.replace(/_/g, " ")}
                    value={consent?.enabled === true}
                    onChange={(v) =>
                      void patch({ ambientSources: { [key]: { enabled: v } } })
                    }
                  />
                ))
              )}
            </>
          ) : null}

          {!settings && page !== "subscription" ? (
            <ActivityIndicator color="#a1a1aa" style={{ marginTop: 30 }} />
          ) : null}
        </ScrollView>
      </View>
    );
  }

  return (
    <View className="flex-1">
      <PageHeader
        title="Setting"
        subtitle="Subscription · Preferences · Notifications · Ambient"
        {...headerProps}
      />
      <ScrollView className="flex-1 px-5" contentContainerClassName="pb-12">
        {/* 账号卡 */}
        <GlassCard strong className="mb-4 flex-row items-center gap-3 px-4 py-3.5">
          <View className="h-11 w-11 items-center justify-center rounded-full bg-white/90 border border-white/70">
            <Text className="text-[16px] text-foreground/70" style={{ fontFamily: "Inter_600SemiBold" }}>
              {initial}
            </Text>
          </View>
          <View className="flex-1">
            <Text className="text-[15px] text-foreground" style={{ fontFamily: "Inter_600SemiBold" }} numberOfLines={1}>
              {displayName}
            </Text>
            <Text className="mt-0.5 text-[12px] text-muted-foreground" numberOfLines={1} style={{ fontFamily: "Inter_400Regular" }}>
              {user.email}
            </Text>
          </View>
          <Pressable
            onPress={() => void onSignOut()}
            className="rounded-full bg-white/85 border border-white/70 px-3.5 py-2"
          >
            <Text className="text-[12px] text-foreground/80" style={{ fontFamily: "Inter_600SemiBold" }}>
              Sign out
            </Text>
          </Pressable>
        </GlassCard>

        <SettingRow
          Icon={Sparkles}
          title="Subscription & Billing"
          subtitle="Manage plan, billing, payment"
          badge={planCode !== "free" ? planCode.toUpperCase() : undefined}
          onPress={() => setPage("subscription")}
        />
        <SettingRow
          Icon={Settings2}
          title="Preferences"
          subtitle="Tone, formatting, defaults"
          onPress={() => setPage("preferences")}
        />
        <SettingRow
          Icon={Bell}
          title="Push Notifications"
          subtitle="What gets through — even during quiet hours"
          onPress={() => setPage("notifications")}
        />
        <SettingRow
          Icon={Radio}
          title="Ambient"
          subtitle="Source consents, summaries"
          onPress={() => setPage("ambient")}
        />
      </ScrollView>
    </View>
  );
}
