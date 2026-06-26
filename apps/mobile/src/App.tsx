/**
 * RN app 根：transport 注入（import 副作用，业界入口惯例同 web main.tsx）
 * → TQ Provider → auth gate → 登录后启动同步引擎 + main chat。
 * 七视图 shell / NOW 卡片 / Connect 等是后续刀，本刀只立核心链路。
 */
import "../global.css";
import "../src/lib/transport-bootstrap";

import { useEffect, useState } from "react";
import { ActivityIndicator, Modal, StyleSheet, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useFonts, Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold } from "@expo-google-fonts/inter";
import { Geist_400Regular, Geist_500Medium, Geist_600SemiBold, Geist_700Bold } from "@expo-google-fonts/geist";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { User } from "@supabase/supabase-js";

import { registerSignOutCleanup } from "@pin-ai/core";
import { useUserSettings } from "@pin-ai/state";

import { useAuth } from "./hooks/useAuth";
import { clearDeviceCredentials } from "./lib/devices";
import { startSync } from "./lib/sync/sync-bootstrap";
import { resumeAmbientIfEnabled } from "./ambient/runtime";
import AppShell from "./components/app/AppShell";
import VideoBackdrop from "./ui/VideoBackdrop";
import { registerPush } from "./lib/push";
import LoginScreen from "./screens/LoginScreen";
import { VoiceProvider } from "./voice";

const queryClient = new QueryClient();

// signOut 时清 device 凭据(secure-store)——注册进 core 的 signOut 清理链
// (useAuth.signOut → runSignOutCleanups)。registerExternalMicAcquirer /
// registerFeedbackOutbox / registerLocalThreadStore 待对应实现就绪后续 wire。
registerSignOutCleanup(clearDeviceCredentials);

function Root() {
  const { loading, user, signInWithGoogle, signOut } = useAuth();
  // Composer permission mode is a shared /settings value. Root fetches it once
  // after auth so every composer/menu instance follows the same TQ cache.
  useUserSettings(user?.id ?? null);
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

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#71717a" />
      </View>
    );
  }
  if (!user) return <LoginScreen onSignIn={signInWithGoogle} />;
  return <AppShell user={user} onSignOut={signOut} />;
}

export default function App() {
  return (
    <GestureHandlerRootView style={styles.safe}>
      <QueryClientProvider client={queryClient}>
        <SafeAreaProvider>
          {/* 主壳背景：web VideoBackdrop（constellation-bg.mp4 缓动视频，white/70
              白罩）。chat / card chat 各自盖自己的 AuroraBackground，不吃这层。 */}
          <VideoBackdrop />
          <SafeAreaView style={styles.safeTransparent} edges={["top", "bottom"]}>
            <StatusBar style="dark" />
            <VoiceProvider>
              <Root />
            </VoiceProvider>
          </SafeAreaView>
        </SafeAreaProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  // token --background: 220 30% 96%（web bg-background 同源）。
  safe: { flex: 1, backgroundColor: "#f2f4f8" },
  safeTransparent: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#f2f4f8" },
  shell: { flex: 1 },
  screen: { flex: 1 },
  // 保 mount 的隐藏（不卸载——main chat 的 SSE 在后台 tab 持续）。
  hiddenScreen: { display: "none" },
});
