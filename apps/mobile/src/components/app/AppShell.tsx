/**
 * App 壳——web AppLayout 导航范式的 RN 对应物：
 * - MenuId 状态机（六页，无 bottom tab）
 * - 每页 = PageHeader + 内容；NOW/Chat 常 mount 保流，其余按需挂载
 * - 右侧抽屉（汉堡/右缘手势）、ASK PIN AI 上拉 chat、card chat modal
 */
import { useState } from "react";
import { Modal, StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { FadeIn, FadeOut, runOnJS } from "react-native-reanimated";
import type { User } from "@supabase/supabase-js";
import type { IntentCard } from "@pin-ai/core";

import AskPinAiBar from "./AskPinAiBar";
import ChatSheet from "./ChatSheet";
import DebugPanel from "./DebugPanel";
import MenuDrawer, { type MenuId } from "./MenuDrawer";
import CardChatScreen from "../../screens/CardChatScreen";
import ConnectScreen from "../../screens/ConnectScreen";
import SettingScreen from "../../screens/SettingScreen";
import NowScreen from "../../screens/NowScreen";
import TasksScreen from "../../screens/TasksScreen";
import AmbientScreen from "../../screens/AmbientScreen";
import ProfileScreen from "../../screens/ProfileScreen";

export default function AppShell({
  user,
  onSignOut,
}: {
  user: User;
  onSignOut: () => Promise<void>;
}) {
  const [view, setView] = useState<MenuId>("now");
  const [menuOpen, setMenuOpen] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [cardChat, setCardChat] = useState<{ card: IntentCard; bootstrap: string } | null>(null);

  // web AppLayout 同构：full_name 首词 → email 前缀 → "there"。
  const userMeta = user.user_metadata as { full_name?: string; name?: string } | undefined;
  const fullName = userMeta?.full_name || userMeta?.name || "";
  const firstName = fullName ? fullName.split(" ")[0] : "";
  const emailPrefix = user.email ? user.email.split("@")[0] : "";
  const displayName = firstName || emailPrefix || "there";

  const headerProps = {
    // web 同位：齿轮 = DebugPanel；Setting 页从抽屉菜单进。
    onOpenDebug: () => setDebugOpen(true),
    onOpenMenu: () => setMenuOpen(true),
  };

  // 右缘左滑开菜单（web 的 right-edge swipe 对应物）。
  const edgeSwipe = Gesture.Pan()
    .activeOffsetX(-14)
    .onEnd((e) => {
      if (e.translationX < -40) runOnJS(setMenuOpen)(true);
    });

  return (
    <View style={styles.root}>
      {/* NOW 常 mount（球面/数据保活），其余按需。 */}
      <View style={[styles.page, view !== "now" && styles.hidden]}>
        <NowScreen
          displayName={displayName}
          headerProps={headerProps}
          onOpenChat={(card, bootstrap) => setCardChat({ card, bootstrap })}
          onOpenAmbient={() => setView("ambient")}
          onAskPinAi={() => setChatOpen(true)}
        />
      </View>
      {/* 页面转场：web ViewRouter AnimatePresence opacity 0.2s 对应物
          （exiting 视图脱离布局以 overlay 形式淡出 → cross-fade）。 */}
      {view === "ambient" ? (
        <PageFade>
          <AmbientScreen headerProps={headerProps} userId={user.id} />
        </PageFade>
      ) : null}
      {view === "tasks" ? (
        <PageFade>
          <TasksScreen headerProps={headerProps} onOpenCard={(card) => setCardChat({ card, bootstrap: "" })} />
        </PageFade>
      ) : null}
      {view === "connect" ? (
        <PageFade>
          <ConnectScreen headerProps={headerProps} />
        </PageFade>
      ) : null}
      {view === "profile" ? (
        <PageFade>
          <ProfileScreen headerProps={headerProps} />
        </PageFade>
      ) : null}
      {view === "setting" ? (
        <PageFade>
          <SettingScreen headerProps={headerProps} user={user} onSignOut={onSignOut} />
        </PageFade>
      ) : null}

      {/* 右缘手势热区（窄条，不抢页面手势）。 */}
      <GestureDetector gesture={edgeSwipe}>
        <View style={styles.edgeZone} pointerEvents="box-only" />
      </GestureDetector>

      <ChatSheet open={chatOpen} onClose={() => setChatOpen(false)} />

      <MenuDrawer
        open={menuOpen}
        active={view}
        onNavigate={(id) => {
          setView(id);
          setMenuOpen(false);
          setChatOpen(false);
        }}
        onClose={() => setMenuOpen(false)}
      />

      <DebugPanel open={debugOpen} onClose={() => setDebugOpen(false)} onSignOut={onSignOut} />

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

/** 页面淡入淡出壳。exiting 时 Reanimated 把视图脱离布局以 overlay 淡出，
 *  与新页的 FadeIn 形成 cross-fade（NOW 的 display:none 切换不受影响）。 */
function PageFade({ children }: { children: React.ReactNode }) {
  return (
    <Animated.View
      style={styles.page}
      entering={FadeIn.duration(200)}
      exiting={FadeOut.duration(200)}
    >
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  page: { flex: 1 },
  hidden: { display: "none" },
  edgeZone: { position: "absolute", right: 0, top: 80, bottom: 80, width: 16 },
});
