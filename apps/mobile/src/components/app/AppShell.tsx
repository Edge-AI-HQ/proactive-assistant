/**
 * App 壳——web AppLayout 导航范式的 RN 对应物：
 * - MenuId 状态机（六页，无 bottom tab）
 * - 页面 keep-alive 栈：每页首访挂载后常驻（display:none 隐藏，不卸载），
 *   切回零重载、滚动/状态原位；KeepAlivePage 的 PageActiveContext 把常驻页的
 *   动画循环按可见性停帧（防发热）。
 * - MenuDrawerHost 全局抽屉：任意页左滑跟手拉出、开态右滑关闭（见 MenuDrawer.tsx）。
 * - 登录后空闲预取 Profile/Devices/Memories → 首访任何页也无 loading。
 * - ASK PIN AI 上拉 chat、card chat modal。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import type { User } from "@supabase/supabase-js";
import type { IntentCard } from "@pin-ai/core";
import { fetchMemories, fetchProfileSnapshot, listUserDevices, deleteAccount, DeleteAccountError } from "@pin-ai/core";
import { cardsKeys, profileKeys, profileMemoriesKeys, userDevicesKeys, useComposio, usePipeline } from "@pin-ai/state";

import AgentRunIndicator from "./AgentRunIndicator";
import { CardActionsProvider } from "./CardActionsProvider";
import ChatSheet from "./ChatSheet";
import DebugPanel from "./DebugPanel";
import { KeepAlivePage } from "./KeepAlivePage";
import MenuDrawerHost, { type MenuId } from "./MenuDrawer";
import PreNotificationPrompt from "../account/PreNotificationPrompt";
import CardChatScreen from "../../screens/CardChatScreen";
import ConnectScreen from "../../screens/ConnectScreen";
import SettingScreen from "../../screens/SettingScreen";
import NowScreen from "../../screens/NowScreen";
import TasksScreen from "../../screens/TasksScreen";
import AmbientScreen from "../../screens/AmbientScreen";
import ProfileScreen from "../../screens/ProfileScreen";
import { useAmbientConsentReconcile } from "../../hooks/useAmbientConsentReconcile";
import { useAmbientToggle } from "../../hooks/useAmbientToggle";
import { bindSystemShortcutActions } from "../../lib/system-shortcuts";

export default function AppShell({
  user,
  onSignOut,
}: {
  user: User;
  onSignOut: () => Promise<void>;
}) {
  const [view, setView] = useState<MenuId>("now");
  // 首访过的页集合：进过就常驻挂载（keep-alive），永不回退。
  const [visited, setVisited] = useState<ReadonlySet<MenuId>>(() => new Set<MenuId>(["now"]));
  const [menuOpen, setMenuOpen] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [cardChat, setCardChat] = useState<{ card: IntentCard; bootstrap: string } | null>(null);
  // web AppLayout 同位：composio state 壳级持有、跨 view 保活（CONNECT 页消费）。
  const composio = useComposio();
  const { t } = useTranslation(["common", "card"]);
  const queryClient = useQueryClient();

  // consent → 采集源实时调和（dev App.tsx boot/settings 效应同位，挂登录后
  // 常驻树）：server ambientSources 变化时把在采源集合调和到 consent 真集。
  useAmbientConsentReconcile(user.id);

  // Siri Shortcuts 深链（dev AppLayout 同款 ref 间接层）：绑定只挂一次
  // （冷启 URL 重放 + 前台监听），动作经 ref 永远打到最新 toggle/pipeline。
  // useAmbientToggle 是纯编排 hook（态在共享 TQ cache + runtime store），
  // AppShell 再实例化与 NOW/Ambient 的开关同步，安全。
  const { toggle } = useAmbientToggle(user.id);
  const pipeline = usePipeline();
  const shortcutRef = useRef({ onToggleAmbient: () => {}, onGenerateCards: () => {} });
  useEffect(
    () =>
      bindSystemShortcutActions({
        onToggleAmbient: () => shortcutRef.current.onToggleAmbient(),
        onGenerateCards: () => shortcutRef.current.onGenerateCards(),
      }),
    [],
  );
  useEffect(() => {
    shortcutRef.current = {
      onToggleAmbient: () => {
        void toggle();
      },
      onGenerateCards: () => {
        pipeline.generate();
      },
    };
  }, [toggle, pipeline.generate]);

  // 生成完成 → 立即刷卡（dev AppLayout:312-317 同构；generate 跑完球面不再等
  // 30s 轮询）。runId 去重防 run state 重渲重复触发。
  const lastCompleteRunIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (pipeline.run.status !== "complete" || !pipeline.run.runId) return;
    if (pipeline.run.runId === lastCompleteRunIdRef.current) return;
    lastCompleteRunIdRef.current = pipeline.run.runId;
    void queryClient.invalidateQueries({ queryKey: cardsKeys.all });
  }, [pipeline.run.runId, pipeline.run.status, queryClient]);

  // 登录后空闲预取：把用户迟早会进的页面数据先填进 TQ 缓存（SWR——进页秒出
  // 缓存、后台再刷新）。cards/settings/composio 已由常驻消费者（NOW/Root/本壳）
  // 天然暖着，无需重复。延迟 1.2s 避开首屏渲染与 NOW 首拉的窗口。
  useEffect(() => {
    const timer = setTimeout(() => {
      void queryClient.prefetchQuery({
        queryKey: profileKeys.snapshot(),
        queryFn: ({ signal }) => fetchProfileSnapshot(signal),
      });
      void queryClient.prefetchQuery({
        queryKey: userDevicesKeys.all,
        queryFn: () => listUserDevices(),
      });
      // 参数须与 packages/state/queries/profile.ts useProfileMemories 首页一致（页宽 5）。
      void queryClient.prefetchInfiniteQuery({
        queryKey: profileMemoriesKeys.list(),
        queryFn: ({ pageParam, signal }) =>
          fetchMemories(
            {
              status: "active",
              limit: 5,
              offset: pageParam,
              orderBy: "created_at",
              orderDirection: "desc",
            },
            signal,
          ),
        initialPageParam: 0,
      });
    }, 1_200);
    return () => clearTimeout(timer);
  }, [queryClient]);

  // web AppLayout 同构：full_name 首词 → email 前缀 → t(card:now.greetingFallbackName)。
  const userMeta = user.user_metadata as { full_name?: string; name?: string } | undefined;
  const fullName = userMeta?.full_name || userMeta?.name || "";
  const firstName = fullName ? fullName.split(" ")[0] : "";
  const emailPrefix = user.email ? user.email.split("@")[0] : "";
  const displayName = firstName || emailPrefix || t("card:now.greetingFallbackName");

  const headerProps = {
    // web 同位：齿轮 = DebugPanel；Setting 页从抽屉菜单进。
    onOpenDebug: () => setDebugOpen(true),
    onOpenMenu: () => setMenuOpen(true),
  };

  const navigate = (id: MenuId) => {
    setVisited((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    setView(id);
  };

  // 深链到 Settings 子页（NOW 空态 Review permissions / Ambient 模型引导 → 直接进
  // Ambient 子页，对齐 dev 目标；不再只停在设置主页）。SettingScreen 消费后回调复位。
  const [settingPage, setSettingPage] = useState<"ambient" | null>(null);
  const openSettingPage = (page: "ambient") => {
    setSettingPage(page);
    navigate("setting");
  };
  const consumeSettingPage = useCallback(() => setSettingPage(null), []);

  // web AppLayout handleDeleteAccount 同构：删账链路（Composio→LiteLLM→Stripe→
  // Browserbase→Storage→Supabase Auth→DB CASCADE）走 core deleteAccount；外部非
  // 致命失败只 warn（cascade 已成功），fail-fast 抛 DeleteAccountError；成功即登出
  // （JWT 已死，任何后续调用会 401）。
  const handleDeleteAccount = async () => {
    let result;
    try {
      result = await deleteAccount();
    } catch (err) {
      if (err instanceof DeleteAccountError && err.partial) {
        console.warn("[account] delete partial state:", err.partial);
      }
      throw err;
    }
    if (
      result.composioErrors.length > 0
      || result.litellmError
      || result.stripeError
      || result.browserbaseError
      || result.storageError
    ) {
      console.warn("[account] delete: non-fatal external failures", result);
    }
    await onSignOut();
  };

  return (
    <View style={styles.root}>
      {/* 壳级卡片动作单实例（web CardStateProvider 同位）：NOW 球面 / TASKS /
          CardDetailSheet 经 context 共享同一份乐观集合。 */}
      <CardActionsProvider
        composio={composio}
        onOpenChat={(card, bootstrap) => setCardChat({ card, bootstrap })}
      >
        <MenuDrawerHost
          open={menuOpen}
          active={view}
          onRequestOpen={() => setMenuOpen(true)}
          onRequestClose={() => setMenuOpen(false)}
          onNavigate={(id) => {
            navigate(id);
            setMenuOpen(false);
            setChatOpen(false);
          }}
        >
          {/* NOW 常驻（球面/数据保活）。active 门控球体自转：仅当 NOW 是当前页
              且无 chat 盖在上面才转——否则 60fps 帧回路空跑发热。 */}
          <KeepAlivePage active={view === "now"}>
            <NowScreen
              displayName={displayName}
              userId={user.id}
              headerProps={headerProps}
              active={view === "now" && !chatOpen && !cardChat}
              onOpenChat={(card, bootstrap) => setCardChat({ card, bootstrap })}
              onOpenAmbient={() => navigate("ambient")}
              onAskPinAi={() => setChatOpen(true)}
              onOpenConnect={() => navigate("connect")}
              onReviewPermissions={() => openSettingPage("ambient")}
            />
          </KeepAlivePage>
          {visited.has("ambient") ? (
            <KeepAlivePage active={view === "ambient"}>
              <AmbientScreen
                headerProps={headerProps}
                userId={user.id}
                onOpenConnect={() => navigate("connect")}
                onOpenChat={(card, bootstrap) => setCardChat({ card, bootstrap })}
                onOpenModelSetup={() => openSettingPage("ambient")}
              />
            </KeepAlivePage>
          ) : null}
          {visited.has("tasks") ? (
            <KeepAlivePage active={view === "tasks"}>
              <TasksScreen
                headerProps={headerProps}
                onOpenChat={(card, bootstrap) => setCardChat({ card, bootstrap })}
              />
            </KeepAlivePage>
          ) : null}
          {visited.has("connect") ? (
            <KeepAlivePage active={view === "connect"}>
              <ConnectScreen headerProps={headerProps} composio={composio} />
            </KeepAlivePage>
          ) : null}
          {visited.has("profile") ? (
            <KeepAlivePage active={view === "profile"}>
              <ProfileScreen headerProps={headerProps} />
            </KeepAlivePage>
          ) : null}
          {visited.has("setting") ? (
            <KeepAlivePage active={view === "setting"}>
              <SettingScreen
                headerProps={headerProps}
                user={user}
                onSignOut={onSignOut}
                pendingPage={settingPage}
                onConsumePendingPage={consumeSettingPage}
              />
            </KeepAlivePage>
          ) : null}
        </MenuDrawerHost>

        {/* in-flight agent runs 徽章（自带绝对定位，PageHeader 双圆钮左侧）；
            ChatSheet/CardChatScreen 等全屏 sheet 在其后渲染，天然盖住它。 */}
        <AgentRunIndicator />

        <ChatSheet open={chatOpen} onClose={() => setChatOpen(false)} />

        <DebugPanel
          open={debugOpen}
          onClose={() => setDebugOpen(false)}
          onSignOut={onSignOut}
          composio={composio}
          onDeleteAccount={handleDeleteAccount}
        />

        {/* card chat：和 ChatSheet 同款 in-tree 下沉 sheet（不是 Modal 独立窗口，
            否则没法下沉露出底下页面）。常 mount，target 驱动上弹/下沉。 */}
        <CardChatScreen target={cardChat} onClose={() => setCardChat(null)} />

        {/* 通知权限预询 sheet（自包含 gate：OS 可询问且 settings 未盖章才现身）。 */}
        <PreNotificationPrompt userId={user.id} />
      </CardActionsProvider>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
