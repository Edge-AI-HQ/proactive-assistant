/**
 * App 壳——web AppLayout 导航范式的 RN 对应物：
 * - MenuId 状态机（六页，无 bottom tab）
 * - 每页 = PageHeader + 内容；NOW/Chat 常 mount 保流，其余按需挂载
 * - 右侧抽屉（汉堡/右缘手势）、ASK PIN AI 上拉 chat、card chat modal
 */
import { useState } from "react";
import { Modal, StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";
import type { User } from "@supabase/supabase-js";
import type { IntentCard } from "@pin-ai/core";

import AskPinAiBar from "./AskPinAiBar";
import ChatSheet from "./ChatSheet";
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
  const [chatOpen, setChatOpen] = useState(false);
  const [cardChat, setCardChat] = useState<{ card: IntentCard; bootstrap: string } | null>(null);

  const headerProps = {
    onOpenSettings: () => {
      setView("setting");
      setMenuOpen(false);
    },
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
          headerProps={headerProps}
          onOpenChat={(card, bootstrap) => setCardChat({ card, bootstrap })}
          onOpenAmbient={() => setView("ambient")}
          onAskPinAi={() => setChatOpen(true)}
        />
      </View>
      {view === "ambient" ? <AmbientScreen headerProps={headerProps} /> : null}
      {view === "tasks" ? (
        <TasksScreen headerProps={headerProps} onOpenCard={(card) => setCardChat({ card, bootstrap: "" })} />
      ) : null}
      {view === "connect" ? <ConnectScreen headerProps={headerProps} /> : null}
      {view === "profile" ? <ProfileScreen headerProps={headerProps} /> : null}
      {view === "setting" ? (
        <SettingScreen headerProps={headerProps} user={user} onSignOut={onSignOut} />
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

const styles = StyleSheet.create({
  root: { flex: 1 },
  page: { flex: 1 },
  hidden: { display: "none" },
  edgeZone: { position: "absolute", right: 0, top: 80, bottom: 80, width: 16 },
});
