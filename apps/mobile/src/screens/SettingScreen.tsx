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
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  Switch,
  Text,
  View,
} from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import {
  Bell,
  ChevronLeft,
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
import { EM_TIGHT, tracking } from "../ui/typography";
import PageHeader from "../components/app/PageHeader";
import { usePushNotifications } from "../hooks/usePushNotifications";
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
    <View className="flex-row items-center gap-1 px-6 pt-4 pb-2">
      {/* 设计仓 main BackButton：ChevronLeft 22/1.8、无底色、foreground/70；按下 → foreground +
          bg foreground/0.06（= web `hover:bg-foreground/[0.06] transition-colors` 的触屏等价）。
          用 Pressable children-as-function 拿 pressed 态放内层 View（避开本项目 Pressable style 不渲染）。
          设计稿是箭头/标题分 2 行，本项目按用户要求保持 1 行（箭头 + 标题同行）。 */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Back from ${title}`}
        onPress={onBack}
        hitSlop={8}
      >
        {({ pressed }) => (
          <View
            style={{
              padding: 8,
              marginLeft: -8,
              borderRadius: 999,
              backgroundColor: pressed ? "hsla(230, 25%, 15%, 0.06)" : "transparent",
            }}
          >
            <ChevronLeft
              size={22}
              strokeWidth={1.8}
              color={pressed ? "hsl(230, 25%, 15%)" : "hsla(230, 25%, 15%, 0.7)"}
            />
          </View>
        )}
      </Pressable>
      {/* 标题对齐设计仓 h1：text-2xl(24)/font-semibold(600)/tracking-tight/leading-tight(30)。单行截断。 */}
      <Text
        numberOfLines={1}
        className="flex-1 text-[24px] text-foreground"
        style={{ fontFamily: "Inter_600SemiBold", letterSpacing: tracking(24, EM_TIGHT), lineHeight: 30 }}
      >
        {title}
      </Text>
    </View>
  );
}

// --foreground / --background 通道值（对齐 AmbientScreen 的 token）。NativeWind 的
// hsl(var()) 无 alpha 槽 → 带透明度色一律内联 hsla，保证渲染。
const NOTIFY_FG = "hsl(230, 25%, 15%)";
const NOTIFY_FG_20 = "hsla(230, 25%, 15%, 0.2)";
const NOTIFY_BG = "hsl(220, 30%, 96%)";

/**
 * web NotificationsSubPage 卡片的 RN 对应物：标题 + 权限感知副标题 + 右侧开关。
 * 注：web 是「整卡可点」，本项目按用户要求改成「只有开关可点」——所以卡片本身
 * 不可点（普通 GlassCard），交互全在 NotifyToggle（它才是触发权限流程的按钮）。
 */
function NotificationCard({
  on,
  subtitle,
  disabled,
  onPress,
}: {
  on: boolean;
  subtitle: string;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <GlassCard strong className="flex-row items-center gap-3 px-4 py-4">
      <View className="flex-1">
        <Text className="text-[14px] text-foreground" style={{ fontFamily: "Inter_600SemiBold" }}>
          Card generation
        </Text>
        <Text className="mt-0.5 text-[12px] text-muted-foreground" style={{ fontFamily: "Inter_400Regular" }}>
          {subtitle}
        </Text>
      </View>
      <NotifyToggle on={on} disabled={disabled} onPress={onPress} />
    </GlassCard>
  );
}

/**
 * 权限开关按钮（web w-10 h-6 = 40×24 轨 + 20 拇指，off x=2 / on x=18，tween 200ms）。
 * 这是卡片里唯一可点的元素：点它触发权限流程（弹询问 / 跳系统设置 / 切偏好）。
 * Pressable 只管 onPress（本项目 Pressable 的 style 不渲染 → 视觉全在内层 View），
 * hitSlop 10 把 40×24 的小目标扩到 ≥44 易点。
 */
function NotifyToggle({ on, disabled, onPress }: { on: boolean; disabled: boolean; onPress: () => void }) {
  const x = useSharedValue(on ? 16 : 0);
  useEffect(() => {
    x.value = withTiming(on ? 16 : 0, { duration: 200 });
  }, [on, x]);
  const thumbStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={10}
      accessibilityRole="switch"
      accessibilityState={{ checked: on, disabled }}
    >
      <View
        style={{
          width: 40,
          height: 24,
          borderRadius: 12,
          justifyContent: "center",
          backgroundColor: on ? NOTIFY_FG : NOTIFY_FG_20,
        }}
      >
        <Animated.View
          style={[
            {
              position: "absolute",
              left: 2,
              width: 20,
              height: 20,
              borderRadius: 10,
              backgroundColor: NOTIFY_BG,
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
  const { settings, patch, loading, saving } = useUserSettings(user.id ?? null);
  const push = usePushNotifications(user.id ?? null);
  const subscription = useQuery({
    queryKey: ["payment", "subscription"],
    queryFn: () => getCurrentSubscription(),
    staleTime: 60_000,
  });

  const planCode = subscription.data?.planCode ?? "free";
  const displayName =
    (user.user_metadata?.full_name as string | undefined) ?? user.email ?? user.id;
  const initial = (displayName[0] ?? "?").toUpperCase();

  // Push Notifications：OS 权限（能力）gate 住产品偏好 notifyNewCards，
  // 对齐 web AccountPanel 的 NotificationsSubPage。isOn = 已授权 && 偏好开。
  const pushUnsupported = push.permissionState === "unsupported";
  const pushGranted = push.permissionState === "granted";
  const pushDenied = push.permissionState === "denied";
  const pushPromptable = push.permissionState === "prompt";
  const notifyNewCards = settings?.notifyNewCards ?? false;
  const notifyOn = pushGranted && notifyNewCards;
  const notifyBusy = !push.ready || loading || saving;
  const notifySubtitle = pushUnsupported
    ? "Available only in the iOS app."
    : pushDenied
      ? "Disabled in system settings — tap to open."
      : notifyOn
        ? "Notify me when AI surfaces a new proactive card."
        : pushGranted
          ? "Paused in PIN AI — tap to resume card alerts."
          : "Tap to enable system notifications.";
  const handleNotifyToggle = async () => {
    if (pushUnsupported || notifyBusy) return;
    if (!pushGranted) {
      if (pushPromptable) {
        const next = await push.requestPermission();
        if (next === "granted") void patch({ notifyNewCards: true });
        return;
      }
      // iOS 通知权限一旦被拒，只有系统设置能再开（web 用 app-settings:）。
      void Linking.openSettings();
      return;
    }
    if (!settings) return;
    void patch({ notifyNewCards: !notifyNewCards });
  };

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

          {page === "notifications" ? (
            <NotificationCard
              on={notifyOn}
              subtitle={notifySubtitle}
              disabled={pushUnsupported || notifyBusy}
              onPress={() => void handleNotifyToggle()}
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

          {!settings && page !== "subscription" && page !== "notifications" ? (
            <ActivityIndicator color="#a1a1aa" style={{ marginTop: 30 }} />
          ) : null}
        </ScrollView>
      </View>
    );
  }

  return (
    <View className="flex-1">
      <PageHeader title="Setting" {...headerProps} />
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
