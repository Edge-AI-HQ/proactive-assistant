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
import { memo, useCallback, useEffect, useState } from "react";
import { InteractionManager, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { User } from "@supabase/supabase-js";
import type { IntentCard } from "@pin-ai/core";
import { deleteAccount, DeleteAccountError } from "@pin-ai/core";
import { useComposio } from "@pin-ai/state";

import AgentRunIndicator from "./AgentRunIndicator";
import { CardActionsProvider } from "./CardActionsProvider";
import ChatSheet from "./ChatSheet";
import DebugPanel from "./DebugPanel";
import ShellEffects from "./ShellEffects";
import { setFullCover } from "../../lib/full-cover";
import { KeepAlivePage } from "./KeepAlivePage";
// __HEAT_PROBE__ 临时发热探针(排查完删)。
import { probeCount } from "../../lib/heat-probe";
import MenuDrawerHost, { type MenuId } from "./MenuDrawer";
import PreNotificationPrompt from "../account/PreNotificationPrompt";
import CardChatScreen from "../../screens/CardChatScreen";
import ConnectScreen from "../../screens/ConnectScreen";
import SettingScreen from "../../screens/SettingScreen";
import NowScreen from "../../screens/NowScreen";
import TasksScreen from "../../screens/TasksScreen";
import AmbientScreen from "../../screens/AmbientScreen";
import ProfileScreen from "../../screens/ProfileScreen";

function AppShell({
  user,
  onSignOut,
}: {
  user: User;
  onSignOut: () => Promise<void>;
}) {
  probeCount("render.AppShell"); // __HEAT_PROBE__
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

  // chat/card-chat 全屏盖住主壳 → 通知根部 VideoBackdrop 暂停背景视频解码省电（WS6）。
  // debug 面板也算：340pt 毛玻璃罩在动视频上=每帧重采样，开着面板测发热会自热
  // （2026-07-05 探针数据佐证），暂停背景视频让测量干净。
  useEffect(() => {
    setFullCover(chatOpen || cardChat !== null || debugOpen);
  }, [chatOpen, cardChat, debugOpen]);

  // 登录后空闲预挂载其余 5 个 tab（NOW 已常驻）：错峰一次挂一个，别一帧挤 5 个大页
  // 造成卡顿。切页时目标页早已渲染好在抽屉底下 → 抽屉一消失即完整新页，无「现搭+淡入」
  // （丝滑切换北极星）。复用 ShellEffects 已有的空闲预取范式（数据）——这里预挂载 UI。
  useEffect(() => {
    // setting 不预挂载：它极少访问（抽屉末项），且其 usePushNotifications 会在 mount
    // 时静默查权限 + 幂等注册 token——虽无害（不弹框、App.tsx 登录已注册），但没必要
    // 在隐藏态提前跑。首次进 setting 走 navigate 的 rAF 兜底懒挂载即可。
    const order: MenuId[] = ["ambient", "tasks", "connect", "profile"];
    let i = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const mountNext = () => {
      const id = order[i++];
      if (!id) return;
      setVisited((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
      timer = setTimeout(mountNext, 150);
    };
    const task = InteractionManager.runAfterInteractions(mountNext);
    return () => {
      task.cancel();
      if (timer) clearTimeout(timer);
    };
  }, []);

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
    // 已挂载（首访过或已被下面的空闲预挂载 warm 过）→ 即时切页，无延帧、无淡入，
    // 目标页早已就绪 → 抽屉一消失就是完整新页（丝滑，对齐主流 App 的 tab 秒切）。
    if (visited.has(id)) {
      setView(id);
      return;
    }
    // 未挂载（预挂载还没轮到，少见）→ 延一帧再现搭，别阻塞点击当帧的反馈（WS2 兜底）。
    requestAnimationFrame(() => {
      setVisited((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
      setView(id);
    });
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
        {/* 壳级副作用宿主（WS1）：轮询/settings 订阅集中在此 null 组件，与 AppShell 渲染隔离。 */}
        <ShellEffects userId={user.id} />
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

// memo：Root 订阅 useUserSettings，任何 settings 写入都会重渲 Root → AppShell。AppShell
// 从 Root 拿的 props（user / onSignOut）稳定（onSignOut useCallback、user 仅 auth 事件变），
// memo 截断 settings 写入引发的整壳重渲级联（WS1）。
export default memo(AppShell);

const styles = StyleSheet.create({
  root: { flex: 1 },
});
