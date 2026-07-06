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

import { useEffect, useState, type ReactNode } from "react";
import { InteractionManager, StyleSheet, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { useFonts, Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold } from "@expo-google-fonts/inter";
import { Geist_400Regular, Geist_500Medium, Geist_600SemiBold, Geist_700Bold } from "@expo-google-fonts/geist";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";

import { registerExternalMicAcquirer, registerFeedbackOutbox, registerSignOutCleanup } from "@pin-ai/core";
import { useUserSettings } from "@pin-ai/state";

import { useAuth } from "./hooks/useAuth";
import { detectDeviceLanguage } from "./i18n";
import { useUiLanguageSync } from "./i18n/useUiLanguageSync";
import { clearDeviceCredentials, ensureDevice } from "./lib/devices";
import { persistOptions, queryClient, setupAppFocusManager } from "./lib/query-client";
import { enqueueFeedback, startSync } from "./lib/sync/sync-bootstrap";
import { resumeAmbientIfEnabled } from "./ambient/runtime";
import { acquireExternalMic } from "./ambient/external-mic";
import AppShell from "./components/app/AppShell";
import OnboardingFlow from "./components/onboarding/OnboardingFlow";
import { ensurePushRegistration, resetPushRegistration } from "./lib/push";
import { BootstrapError } from "./screens/BootScreen";
import SplashScreen from "./screens/SplashScreen";
import LoginScreen from "./screens/LoginScreen";
import { VoiceProvider } from "./voice";

// signOut 清理链由 performSignOut 收口（lib/sign-out.ts）；这里把 device 凭据
// (secure-store)清理注册进 core 清理链(useAuth.signOut → runSignOutCleanups)。
// registerFeedbackOutbox 已接 sync outbox；registerLocalThreadStore 不注册——
// RN 在 ChatScreen/CardDetailSheet 显式传 readLocalHistory/notifyThreadActivity。
registerSignOutCleanup(clearDeviceCredentials);
// 换账号需重新注册 APNs token（不同 device owner）；RN 无 reload，复位 push latch。
registerSignOutCleanup(resetPushRegistration);
registerFeedbackOutbox((body, key) => void enqueueFeedback(body, key));
// AppState → focusManager（TanStack RN 配方）：回前台等价 web 的窗口聚焦刷新。
setupAppFocusManager();
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
    const uid = user.id;
    startSync(uid);
    // ambient：本机此前显式开过才续采（per-device opt-in 隐私不变量）。
    void resumeAmbientIfEnabled(uid);
    // device 注册 + 静默推送注册都是幂等、fire-and-forget 的非紧急动作——错峰到首帧
    // 交互之后再跑,避开 AppShell 首挂载/动画帧（WS7）。语义不变、都是 best-effort。
    const task = InteractionManager.runAfterInteractions(() => {
      // 登录后注册/刷新本机 device 行；失败只 warn——下次启动会再走 ensureDevice。
      void ensureDevice(uid, { forceRefresh: true }).catch((err) => {
        console.warn("[devices] registration failed after sign-in", err);
      });
      // 静默推送注册：OS 已 granted 才上报 token；权限询问归 PreNotificationPrompt 预询流。
      void ensurePushRegistration(uid);
    });
    return () => task.cancel();
  }, [user?.id]);

  // 开屏 splash 最短停留 gate：即使 auth/settings 秒回，也保证品牌开屏球至少露
  // ~1.8s（用户选的「最短停一会 + 加载完为止，取长的」）。加载更慢则由下面的
  // loading / settingsLoading 继续按住 splash——两者取长。
  const [minSplashElapsed, setMinSplashElapsed] = useState(false);
  // splash 盖层淡出结束后置 true → 卸载盖层。
  const [splashGone, setSplashGone] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setMinSplashElapsed(true), 1800);
    return () => clearTimeout(t);
  }, []);

  // dev App.tsx 启动链（顺序同构）：解析要展示的真实内容。booting 期间（auth /
  // settings 未就绪）为 null——此刻只有 splash 盖层在场、底下无内容。关键：一拿到
  // 内容就先挂上（哪怕最短停留没到），让主壳在 splash 底下**提前预热**，淡出时露出
  // 的是已就绪的界面 = 丝滑（对齐抖音 / IG / 微信的 cross-fade，取代原先硬切）。
  let content: ReactNode = null;
  if (!loading) {
    if (!user) {
      content = <LoginScreen onSignIn={signInWithGoogle} />;
    } else if (!settingsLoading) {
      // 进壳前 gate 首份 /settings：拿到才解析下游（null → 可操作 Retry 屏，绝不无限
      // 转圈；未 onboarding → 三步流；就绪 → 主壳）。
      if (settings === null) {
        content = <BootstrapError onRetry={() => void refetchSettings()} />;
      } else if (!settings.onboardingCompletedAt) {
        // dev App.tsx 同位：首启盖章 onboarding + 把设备语言写成正式生成语言。patch
        // 走本实例 useUserSettings（同一 TQ cache，成功即重渲切进主壳）。
        content = (
          <OnboardingFlow
            userId={user.id}
            onComplete={async () => {
              const next = await patchSettings({
                onboardingCompleted: true,
                generationLanguage: detectDeviceLanguage(),
              });
              if (next === null) {
                throw new Error("Couldn't save your onboarding progress. Check your connection and try again.");
              }
            }}
          />
        );
      } else {
        // 主壳背景 VideoBackdrop 挂在 MenuDrawer 玻璃卡内；chat / card chat 各自盖
        // 自己的 AuroraBackground、不吃这层。
        content = (
          <VoiceProvider transcriptionLanguage={settings.generationLanguage}>
            <SafeAreaView style={styles.safeTransparent} edges={["top", "bottom"]}>
              <AppShell user={user} onSignOut={signOut} />
            </SafeAreaView>
          </VoiceProvider>
        );
      }
    }
  }

  // boot 完成 = 内容已就绪 且 最短停留到 → splash 盖层淡出（露出已预热的内容）。
  const bootComplete = content !== null && minSplashElapsed;

  return (
    <View style={styles.safeTransparent}>
      {content}
      {!splashGone ? (
        <SplashScreen visible={!bootComplete} onHidden={() => setSplashGone(true)} />
      ) : null}
    </View>
  );
}

export default function App() {
  return (
    <GestureHandlerRootView style={styles.safe}>
      {/* KeyboardProvider：全树单一「正确测量」的键盘值源（切后台自动重置）——取代 RN 内建
          KeyboardAvoidingView 的安全区双算/不重置/卡死。挂最外层,做 chat KAV + 库 hook 的地基。 */}
      <KeyboardProvider>
        {/* Sync-A：persister 恢复白名单缓存（settings/cards），冷启先渲染上次
            数据、后台 refetch——见 lib/query-client.ts。 */}
        <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>
          <SafeAreaProvider>
            <StatusBar style="dark" />
            <Root />
          </SafeAreaProvider>
        </PersistQueryClientProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  // token --background: 220 30% 96%（web bg-background 同源）。
  safe: { flex: 1, backgroundColor: "#f2f4f8" },
  safeTransparent: { flex: 1 },
});
