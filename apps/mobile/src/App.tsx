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
import { Geist_400Regular, Geist_500Medium, Geist_600SemiBold } from "@expo-google-fonts/geist";
import { LinearGradient } from "expo-linear-gradient";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { User } from "@supabase/supabase-js";

import { useAuth } from "./hooks/useAuth";
import { startSync } from "./lib/sync/sync-bootstrap";
import { resumeAmbientIfEnabled } from "./ambient/runtime";
import AppShell from "./components/app/AppShell";
import AuroraBackground from "./ui/AuroraBackground";
import { registerPush } from "./lib/push";
import LoginScreen from "./screens/LoginScreen";

const queryClient = new QueryClient();

function Root() {
  const { loading, user, signInWithGoogle, signOut } = useAuth();
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
          {/* Aurora 流动背景（web .animate-bg-flow 对应物）。 */}
          <AuroraBackground />
          <SafeAreaView style={styles.safeTransparent} edges={["top", "bottom"]}>
            <StatusBar style="dark" />
            <Root />
          </SafeAreaView>
        </SafeAreaProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#f6f4f0" },
  safeTransparent: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#f6f4f0" },
  shell: { flex: 1 },
  screen: { flex: 1 },
  // 保 mount 的隐藏（不卸载——main chat 的 SSE 在后台 tab 持续）。
  hiddenScreen: { display: "none" },
});
