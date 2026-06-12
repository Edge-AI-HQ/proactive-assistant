/**
 * RN app 根：transport 注入（import 副作用，业界入口惯例同 web main.tsx）
 * → TQ Provider → auth gate → 登录后启动同步引擎 + main chat。
 * 七视图 shell / NOW 卡片 / Connect 等是后续刀，本刀只立核心链路。
 */
import "../src/lib/transport-bootstrap";

import { useEffect, useState } from "react";
import { ActivityIndicator, Modal, StyleSheet, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { LinearGradient } from "expo-linear-gradient";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { User } from "@supabase/supabase-js";
import type { IntentCard } from "@pin-ai/core";

import TabBar, { type TabKey } from "./components/TabBar";
import { useAuth } from "./hooks/useAuth";
import { startSync } from "./lib/sync/sync-bootstrap";
import { resumeAmbientIfEnabled } from "./ambient/runtime";
import { registerPush } from "./lib/push";
import CardChatScreen from "./screens/CardChatScreen";
import ChatScreen from "./screens/ChatScreen";
import LoginScreen from "./screens/LoginScreen";
import ConnectScreen from "./screens/ConnectScreen";
import MeScreen from "./screens/MeScreen";
import NowScreen from "./screens/NowScreen";
import TasksScreen from "./screens/TasksScreen";

const queryClient = new QueryClient();

/** Tab shell：Now/Chat 常驻（hidden 切换，保住 main chat 的在流 SSE——
 *  与 web AppLayout 的保 mount 策略同构）；Tasks/Connect/Me 按需挂载；
 *  card chat 走全屏 modal。 */
function MainShell({ user, onSignOut }: { user: User; onSignOut: () => Promise<void> }) {
  const [tab, setTab] = useState<TabKey>("now");
  const [cardChat, setCardChat] = useState<{ card: IntentCard; bootstrap: string } | null>(null);

  return (
    <View style={styles.shell}>
      <View style={[styles.screen, tab !== "now" && styles.hiddenScreen]}>
        <NowScreen onOpenChat={(card, bootstrap) => setCardChat({ card, bootstrap })} />
      </View>
      {tab === "tasks" ? (
        <View style={styles.screen}>
          <TasksScreen />
        </View>
      ) : null}
      {tab === "connect" ? (
        <View style={styles.screen}>
          <ConnectScreen />
        </View>
      ) : null}
      {tab === "me" ? (
        <View style={styles.screen}>
          <MeScreen user={user} onSignOut={onSignOut} />
        </View>
      ) : null}
      <View style={[styles.screen, tab !== "chat" && styles.hiddenScreen]}>
        <ChatScreen kind="main" />
      </View>
      <TabBar active={tab} onChange={setTab} />
      <Modal
        visible={cardChat !== null}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setCardChat(null)}
      >
        {cardChat ? (
          <CardChatScreen
            card={cardChat.card}
            bootstrap={cardChat.bootstrap}
            onClose={() => setCardChat(null)}
          />
        ) : null}
      </Modal>
    </View>
  );
}

function Root() {
  const { loading, user, signInWithGoogle, signOut } = useAuth();

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
  return <MainShell user={user} onSignOut={signOut} />;
}

export default function App() {
  return (
    <GestureHandlerRootView style={styles.safe}>
      <QueryClientProvider client={queryClient}>
        <SafeAreaProvider>
          {/* 品牌渐变底（web 的 bg-gradient 对应物）。 */}
          <LinearGradient
            colors={["#f8f5ef", "#f3eee6", "#eef0f4"]}
            start={{ x: 0.1, y: 0 }}
            end={{ x: 0.9, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
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
