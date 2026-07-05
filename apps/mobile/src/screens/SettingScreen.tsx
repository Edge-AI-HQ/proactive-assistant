/**
 * SETTING 页——web AccountPanel 的 RN 对应物：
 * 账号卡（avatar 圈 + 名 + email + Sign out 边框 pill）→ 四子页行
 * （Subscription & Billing[Pro 徽] / Preferences / Push Notifications / Ambient）
 * → 子页内联导航（返回箭头 + 左缘滑动返回 SwipeBackLayer）。
 * - Subscription = components/account/SubscriptionPanel（web ui-web 同名组件全量
 *   RN 移植：Stripe 状态/换档/加购/支付方式/账单/取消）；
 * - Preferences = Dreaming(AutoDreamingSettings) + Generation(AutoGenerate +
 *   GenerationLanguage) + Scheduled Tasks 三个 section（对齐 web PreferencesSubPage）；
 * - Notifications = 权限感知通知卡（有意偏离 web：仅开关可点、onHint 去 "your"，用户定）；
 * - Ambient = per-source consents + voice identity + timeline summary + on-device
 *   models 四面板。
 * 用户定偏离（2026-06-29 三轮）：主页与子页均无副标题；返回箭头按设计仓 BackButton。
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Linking, Pressable, ScrollView, Text, View } from "react-native";
import Animated, {
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import {
  Bell,
  ChevronLeft,
  ChevronRight,
  Radio,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react-native";
import type { User } from "@supabase/supabase-js";
import { useQuery } from "@tanstack/react-query";
import { getCurrentSubscription } from "@pin-ai/core";
import { useUserSettings } from "@pin-ai/state";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { GlassCard } from "../ui/GlassCard";
import { EM_TIGHT, tracking } from "../ui/typography";
import PageHeader from "../components/app/PageHeader";
import SwipeBackLayer from "../components/app/SwipeBackLayer";
import AmbientSourceControlsPanel from "../components/ambient/AmbientSourceControlsPanel";
import VoiceIdentitySettings from "../components/ambient/VoiceIdentitySettings";
import AmbientTimelineSummaryStatusPanel from "../components/ambient/AmbientTimelineSummaryStatusPanel";
import AmbientModelsPanel from "../components/ambient/AmbientModelsPanel";
import { SubscriptionPanel } from "../components/account/SubscriptionPanel";
import AutoDreamingSettings from "../components/account/AutoDreamingSettings";
import AutoGenerateSettings from "../components/account/AutoGenerateSettings";
import GenerationLanguageSettings from "../components/account/GenerationLanguageSettings";
import ScheduledTasksSettings from "../components/account/ScheduledTasksSettings";
import { usePushNotifications } from "../hooks/usePushNotifications";
import type { HeaderProps } from "./AmbientScreen";

type SubPage = "main" | "subscription" | "preferences" | "notifications" | "ambient";

// --foreground / --background 通道值（对齐 AmbientScreen 的 token）。NativeWind 的
// hsl(var()) 无 alpha 槽 → 带透明度色一律内联 hsla，保证渲染。
const FG = "230, 25%, 15%";
const fg = (a?: number) => (a === undefined ? `hsl(${FG})` : `hsla(${FG}, ${a})`);
const NOTIFY_BG = "hsl(220, 30%, 96%)";
// Subscription 行 Pro 徽章（web bg-[hsl(304_75%_63%/0.12)] text-[hsl(304_75%_63%)]，
// 文案是 web 里写死的 "Pro"，与实际 plan 无关——parity 照搬）。
const PINK = "hsl(304, 75%, 63%)";

/**
 * 主页行卡 —— web AccountPanel 的入口 button（glass-card-strong p-4 · 40 图标格
 * rounded-xl bg-foreground/[0.06] · 图标 16/1.5/fg70 · 标题 14/600 · 副标题
 * caption fg/50 · chevron 16/1.5/fg35）。
 */
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
      <GlassCard strong className="flex-row items-center gap-3 p-4">
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: 12,
            backgroundColor: fg(0.06),
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon size={16} color={fg(0.7)} strokeWidth={1.5} />
        </View>
        <View className="flex-1" style={{ minWidth: 0 }}>
          <Text className="text-[14px] leading-5 text-foreground" style={{ fontFamily: "Inter_600SemiBold" }}>
            {title}
          </Text>
          <Text
            className="mt-0.5 text-[11px] leading-[15px]"
            style={{ fontFamily: "Inter_400Regular", color: fg(0.5) }}
          >
            {subtitle}
          </Text>
        </View>
        {badge ? (
          <View style={{ borderRadius: 18, paddingHorizontal: 8, paddingVertical: 2, backgroundColor: "hsla(304, 75%, 63%, 0.12)" }}>
            <Text
              style={{
                fontFamily: "Inter_700Bold",
                fontSize: 10,
                lineHeight: 14,
                letterSpacing: 0.5,
                textTransform: "uppercase",
                color: PINK,
              }}
            >
              {badge}
            </Text>
          </View>
        ) : null}
        <ChevronRight size={16} color={fg(0.35)} strokeWidth={1.5} />
      </GlassCard>
    </Pressable>
  );
}

function SubHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <View className="flex-row items-center gap-1 pt-4 pb-2">
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
  const { t } = useTranslation("account");
  return (
    <GlassCard strong className="flex-row items-center gap-3 px-4 py-4">
      <View className="flex-1">
        <Text className="text-[14px] text-foreground" style={{ fontFamily: "Inter_600SemiBold" }}>
          {t("notifications.cardGeneration")}
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
          backgroundColor: on ? fg() : fg(0.2),
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

/** Preferences section 头（web：h2 text-sm/600 + caption fg/42 mt-1，块 mb-3）。 */
function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 14, lineHeight: 20, color: fg() }}>
        {title}
      </Text>
      <Text style={{ marginTop: 4, fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 15, color: fg(0.42) }}>
        {description}
      </Text>
    </View>
  );
}

export default function SettingScreen({
  headerProps,
  user,
  onSignOut,
  pendingPage,
  onConsumePendingPage,
}: {
  headerProps: HeaderProps;
  user: User;
  onSignOut: () => Promise<void>;
  /** 外部深链请求打开的子页（NOW 空态 Review permissions / Ambient 模型引导）。 */
  pendingPage?: SubPage | null;
  onConsumePendingPage?: () => void;
}) {
  const { t } = useTranslation("account");
  const [page, setPage] = useState<SubPage>("main");
  // pendingPage 由 null→目标 的变化触发跳转并消费；SettingScreen 是 keep-alive
  // 常驻，靠消费后复位 null 支持重复深链（否则第二次点同一入口不会再跳）。
  useEffect(() => {
    if (pendingPage) {
      setPage(pendingPage);
      onConsumePendingPage?.();
    }
  }, [pendingPage, onConsumePendingPage]);
  const insets = useSafeAreaInsets();
  const { settings, patch, loading, saving } = useUserSettings(user.id ?? null);
  const push = usePushNotifications(user.id ?? null);
  // Subscription 行徽章显示真实 plan（用户定，有意偏离 dev——dev 源码写死 "Pro"）。
  // free 不显示徽章。
  const subscription = useQuery({
    queryKey: ["payment", "subscription"],
    queryFn: () => getCurrentSubscription(),
    staleTime: 60_000,
  });
  const planCode = subscription.data?.planCode ?? "free";

  const displayName =
    (user.user_metadata?.full_name as string | undefined) ?? user.email ?? t("panel.accountFallback");
  const initial = (displayName[0] ?? "?").toUpperCase();
  const subtitle = user.email ?? t("panel.signedIn");

  // Push Notifications：OS 权限（能力）gate 住产品偏好 notifyNewCards，
  // 对齐 web AccountPanel 的 NotificationsSubPage。isOn = 已授权 && 偏好开。
  const pushUnsupported = push.permissionState === "unsupported";
  const pushGranted = push.permissionState === "granted";
  const pushDenied = push.permissionState === "denied";
  const pushPromptable = push.permissionState === "prompt";
  const notifyNewCards = settings?.notifyNewCards ?? false;
  const notifyOn = pushGranted && notifyNewCards;
  const notifyBusy = !push.ready || loading || saving;
  // onHint 保持硬编码：用户定的偏离（去 "your"，web i18n 原文是 "…when your AI…"）。
  const notifySubtitle = pushUnsupported
    ? t("notifications.iosOnly")
    : pushDenied
      ? t("notifications.deniedHint")
      : notifyOn
        ? "Notify me when AI surfaces a new proactive card."
        : pushGranted
          ? t("notifications.pausedHint")
          : t("notifications.enableHint");
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
      subscription: "Subscription", // dev ui-web SubscriptionPanel 同样硬编码
      preferences: t("preferences.pageTitle"),
      notifications: t("notifications.pageTitle"),
      ambient: t("ambientPage.pageTitle"),
    };
    return (
      // 每个子页保留自己的返回箭头；SwipeBackLayer 加 iOS 式左缘拖动返回（= dev）。
      <SwipeBackLayer onBack={() => setPage("main")}>
        <View className="flex-1">
          {/* SubHeader 挪进 ScrollView 当第一项 → 标题跟随内容滚动(与 dev「整页滚动」一致);
              px-4 对齐 dev 容器。marginTop/Bottom 负 inset → 视口铺到屏幕上/下物理边(内容
              可滚到刘海/home-indicator 下、视频连续无截断);contentContainerStyle 的 padding
              保证首/末内容静止时仍在安全区内。 */}
          <ScrollView
            className="flex-1 px-4"
            contentContainerStyle={{ paddingTop: insets.top, paddingBottom: 48 }}
            style={{ marginTop: -insets.top, marginBottom: -insets.bottom }}
          >
            <SubHeader title={titles[page]} onBack={() => setPage("main")} />
            {page === "subscription" ? <SubscriptionPanel /> : null}

            {page === "preferences" ? (
              <Animated.View entering={FadeIn.duration(300)} style={{ gap: 12 }}>
                <GlassCard strong className="p-4">
                  <SectionHeader
                    title={t("preferences.evolutionTitle")}
                    description={t("preferences.evolutionDescription")}
                  />
                  <AutoDreamingSettings />
                </GlassCard>
                <GlassCard strong className="p-4">
                  <SectionHeader
                    title={t("preferences.generationTitle")}
                    description={t("preferences.generationDescription")}
                  />
                  <AutoGenerateSettings />
                  <GenerationLanguageSettings />
                </GlassCard>
                <GlassCard strong className="p-4">
                  <SectionHeader
                    title={t("preferences.scheduledTasksTitle")}
                    description={t("preferences.scheduledTasksDescription")}
                  />
                  <ScheduledTasksSettings />
                </GlassCard>
              </Animated.View>
            ) : null}

            {page === "notifications" ? (
              <NotificationCard
                on={notifyOn}
                subtitle={notifySubtitle}
                disabled={pushUnsupported || notifyBusy}
                onPress={() => void handleNotifyToggle()}
              />
            ) : null}

            {page === "ambient" ? (
              <Animated.View entering={FadeIn.duration(300)}>
                <AmbientSourceControlsPanel userId={user.id ?? null} />
                <VoiceIdentitySettings userId={user.id ?? null} />
                <AmbientTimelineSummaryStatusPanel />
                <AmbientModelsPanel />
              </Animated.View>
            ) : null}
          </ScrollView>
        </View>
      </SwipeBackLayer>
    );
  }

  return (
    <View className="flex-1">
      <PageHeader title={t("panel.title")} {...headerProps} />
      <ScrollView className="flex-1 px-4" contentContainerClassName="pb-12" style={{ marginBottom: -insets.bottom }}>
        <Animated.View entering={FadeIn.duration(300)} style={{ gap: 12 }}>
          {/* 账号卡 —— web：avatar 48 圆 bg-foreground/10 + initial 16/600/fg70、
              名 14/600、email caption fg/50、Sign out 边框 pill（border-foreground/12
              rounded-lg(20) px-3 py-1 caption/500）。 */}
          <GlassCard strong className="flex-row items-center gap-3 p-4">
            <View
              style={{
                width: 48,
                height: 48,
                borderRadius: 24,
                backgroundColor: fg(0.1),
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 16, lineHeight: 24, color: fg(0.7) }}>
                {initial}
              </Text>
            </View>
            <View className="flex-1" style={{ minWidth: 0 }}>
              <Text
                numberOfLines={1}
                className="text-[14px] leading-5 text-foreground"
                style={{ fontFamily: "Inter_600SemiBold" }}
              >
                {displayName}
              </Text>
              <Text
                numberOfLines={1}
                style={{ fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 15, color: fg(0.5) }}
              >
                {subtitle}
              </Text>
            </View>
            <Pressable onPress={() => void onSignOut()} hitSlop={6}>
              <View
                style={{
                  borderWidth: 1,
                  borderColor: fg(0.12),
                  borderRadius: 20,
                  paddingHorizontal: 12,
                  paddingVertical: 4,
                }}
              >
                <Text style={{ fontFamily: "Inter_500Medium", fontSize: 11, lineHeight: 15, color: fg() }}>
                  {t("panel.signOut")}
                </Text>
              </View>
            </Pressable>
          </GlassCard>

          <SettingRow
            Icon={Sparkles}
            title={t("panel.subscriptionTitle")}
            subtitle={t("panel.subscriptionDescription")}
            badge={planCode !== "free" ? planCode : undefined}
            onPress={() => setPage("subscription")}
          />
          <SettingRow
            Icon={SlidersHorizontal}
            title={t("panel.preferencesTitle")}
            subtitle={t("panel.preferencesDescription")}
            onPress={() => setPage("preferences")}
          />
          <SettingRow
            Icon={Bell}
            title={t("panel.notificationsTitle")}
            subtitle={t("panel.notificationsDescription")}
            onPress={() => setPage("notifications")}
          />
          <SettingRow
            Icon={Radio}
            title={t("panel.ambientTitle")}
            subtitle={t("panel.ambientDescription")}
            onPress={() => setPage("ambient")}
          />
        </Animated.View>
      </ScrollView>
    </View>
  );
}
