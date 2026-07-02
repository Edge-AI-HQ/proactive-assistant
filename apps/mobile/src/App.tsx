/**
 * RN app 根：transport 注入（import 副作用，业界入口惯例同 web main.tsx）
 * → TQ Provider → auth gate → 登录后启动同步引擎 + main chat。
 *
 * 启动链与 dev `proactive-ai-frontend/src/App.tsx` 同构：
 *   authLoading → BootScreen（静止流动渐变 + 转环）
 *   无 user     → LoginScreen（nebula 登录页，自带全屏 LoginBackdrop）
 *   settings 首拉 → BootScreen；重试后仍失败 → BootstrapError（原地 Retry）
 *   未 onboarding → OnboardingFlow（三步向导，Done 盖章 onboardingCompletedAt）
 *   就绪        → VideoBackdrop + AppShell
 * 背景层按阶段自带（boot/login/onboarding/shell 各一套，dev 同构)——不再全局
 * 常挂 VideoBackdrop，登录期零视频解码浪费。
 */
import "../global.css";
import "../src/lib/transport-bootstrap";
// i18n init（side effect，对齐 web「import @pin-ai/ui-web 即 init」）：
// 必须先于任何用 t() 的组件渲染。首屏跟设备语言，登录后 useUiLanguageSync 覆盖。
import "./i18n";

import { useEffect } from "react";
import { StyleSheet } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useFonts, Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold } from "@expo-google-fonts/inter";
import { Geist_400Regular, Geist_500Medium, Geist_600SemiBold, Geist_700Bold } from "@expo-google-fonts/geist";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { registerExternalMicAcquirer, registerSignOutCleanup } from "@pin-ai/core";
import { useUserSettings } from "@pin-ai/state";

import { useAuth } from "./hooks/useAuth";
import { detectDeviceLanguage } from "./i18n";
import { useUiLanguageSync } from "./i18n/useUiLanguageSync";
import { clearDeviceCredentials } from "./lib/devices";
import { startSync } from "./lib/sync/sync-bootstrap";
import { resumeAmbientIfEnabled } from "./ambient/runtime";
import { acquireExternalMic } from "./ambient/external-mic";
import AppShell from "./components/app/AppShell";
import OnboardingFlow from "./components/onboarding/OnboardingFlow";
import VideoBackdrop from "./ui/VideoBackdrop";
import { registerPush } from "./lib/push";
import BootScreen, { BootstrapError } from "./screens/BootScreen";
import LoginScreen from "./screens/LoginScreen";
import { VoiceProvider } from "./voice";

const queryClient = new QueryClient();

// signOut 时清 device 凭据(secure-store)——注册进 core 的 signOut 清理链
// (useAuth.signOut → runSignOutCleanups)。registerFeedbackOutbox /
// registerLocalThreadStore 待对应实现就绪后续 wire。
registerSignOutCleanup(clearDeviceCredentials);
// voice 录音与 ambient 采集的麦克风互斥（对齐 web main.tsx）：录音前让出 native
// ambient 麦、录完恢复。web 用 dynamic import（代码分割）；RN 是单体 bundle，且
// dynamic import() 在本 Hermes/Metro setup 跑不通（Requiring unknown module 4012），
// 故用静态 import——同一能力、平台适配。external-mic 内部对 native 未链接自动降级为 no-op。
registerExternalMicAcquirer(acquireExternalMic);

function Root() {
  const { loading, user, signInWithGoogle, signOut } = useAuth();
  // 共享 /settings：Root 实例登录后即填 TQ cache（composer/menu 全读同一份）；
  // 同时承担 dev App.tsx 的 settings bootstrap gate（进壳前必须拿到首份 settings）。
  const {
    settings,
    loading: settingsLoading,
    refetch: refetchSettings,
    patch: patchSettings,
  } = useUserSettings(user?.id ?? null);
  // settings.generationLanguage → UI 语言（= dev useUiLanguageSync，吃上面
  // root 实例填充的同一 cache）。
  useUiLanguageSync();
  // 品牌字体（web 同源：Inter 全局 + Geist chat 面）。加载极快（本地
  // bundle 资源），未就绪时沿用系统字体渲染，不 gate 首屏。
  useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    Geist_400Regular,
    Geist_500Medium,
    Geist_600SemiBold,
    Geist_700Bold,
  });

  useEffect(() => {
    if (!user?.id) return;
    startSync(user.id);
    // 登录后立即注册推送（权限弹窗在 onboarding 时机问，不做 in-context
    // 延迟——async-heavy app 的通知是核心体验）。
    void registerPush(user.id);
    // ambient：本机此前显式开过才续采（per-device opt-in 隐私不变量）。
    void resumeAmbientIfEnabled(user.id);
  }, [user?.id]);

  // dev App.tsx 启动链（顺序同构）：
  if (loading) return <BootScreen />;
  if (!user) return <LoginScreen onSignIn={signInWithGoogle} />;
  // 进壳前 gate 首份 /settings（dev：in-flight → spinner；重试后仍 null →
  // 可操作的 Retry 屏，绝不无限转圈）。
  if (settingsLoading) return <BootScreen />;
  if (settings === null) return <BootstrapError onRetry={() => void refetchSettings()} />;

  // dev App.tsx 同位：首启（onboardingCompletedAt 未盖章）→ 三步 onboarding，
  // Done 时盖章 + 把检测到的设备语言写成正式生成语言。patch 必须走本实例的
  // useUserSettings（同一 TQ cache，成功即触发本组件重渲切进主壳）。
  if (!settings.onboardingCompletedAt) {
    return (
      <OnboardingFlow
        userId={user.id}
        onComplete={async () => {
          const next = await patchSettings({
            onboardingCompleted: true,
            // 新用户首启：把检测到的设备语言写成正式设置，生成语言同步对齐。
            generationLanguage: detectDeviceLanguage(),
          });
          if (next === null) {
            throw new Error("Couldn't save your onboarding progress. Check your connection and try again.");
          }
        }}
      />
    );
  }

  return (
    <>
      {/* 主壳背景：web VideoBackdrop（constellation-bg.mp4 缓动视频，white/70
          白罩）。chat / card chat 各自盖自己的 AuroraBackground，不吃这层。
          全出血（SafeAreaView 之外），内容层再走安全区。 */}
      <VideoBackdrop />
      <SafeAreaView style={styles.safeTransparent} edges={["top", "bottom"]}>
        <AppShell user={user} onSignOut={signOut} />
      </SafeAreaView>
    </>
  );
}

export default function App() {
  return (
    <GestureHandlerRootView style={styles.safe}>
      <QueryClientProvider client={queryClient}>
        <SafeAreaProvider>
          <StatusBar style="dark" />
          <VoiceProvider>
            <Root />
          </VoiceProvider>
        </SafeAreaProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  // token --background: 220 30% 96%（web bg-background 同源）。
  safe: { flex: 1, backgroundColor: "#f2f4f8" },
  safeTransparent: { flex: 1 },
});
