import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Zap, Radio, ListChecks, Plug, Eye, Settings,
  PanelLeft, PanelLeftClose, Bug,
} from "lucide-react";
import { toast } from "sonner";
import {
  deleteAccount,
  deriveCardUiStatus,
  isHiddenCardOutcome,
  type IntentCard,
} from "@pin-ai/core";
import { useCardsQuery, useComposio, usePipeline, useUserSettings } from "@pin-ai/state";
import {
  CATEGORIES,
  DebugPanel,
  realCardToLovableIntent,
  useAuth,
  useCardActions,
  useWeather,
  type CardStatus,
  type Intent, Text,
} from "@pin-ai/ui-web";
import ZebraBackdrop from "./ZebraBackdrop";
import ZebraNow from "./ZebraNow";
import ZebraCardDetailPanel from "./ZebraCardDetailPanel";
import ZebraConversationPanel from "./ZebraConversationPanel";
import ZebraCardChat from "./ZebraCardChat";
import ZebraTasksSplit from "./ZebraTasksSplit";
import ZebraAmbient from "./ZebraAmbient";
import ZebraConnect from "./ZebraConnect";
import ZebraMirror from "./ZebraMirror";
import { ZebraSetting, ZebraSubscription, ZebraNotifications, ZebraPreferences } from "./ZebraSettings";
import ZebraCommandPalette, { type PaletteCard } from "./ZebraCommandPalette";

/**
 * Desktop (zebra) shell — the web counterpart of the iOS Constellation shell.
 *
 *  - Persistent: mounted once as a layout route across all main paths, so
 *    the background video and panel state survive navigation.
 *  - Floating glass sidebar; each in-shell view is its own URL
 *    (/now, /tasks, …; conversation is an overlay route).
 *  - Card detail / chat / conversation render as right slide-over panels
 *    (440px detail, 560px chat; conversation can expand to focus mode).
 *
 * M1 状态：NOW 球面 + card detail 接真（cards query 投影 + useCardActions
 * 真实 POST + fanout 预跑的 run 数据）；conversation M2、TASKS M3、
 * CONNECT/MIRROR/SETTING M4、AMBIENT M5。
 */

const SLIDE_TRANSITION = { duration: 0.42, ease: [0.32, 0.72, 0, 1] as const };

const NAV_ITEMS = [
  { id: "now", label: "NOW", icon: Zap, path: "/now" },
  { id: "ambient", label: "AMBIENT", icon: Radio, path: "/ambient" },
  { id: "tasks", label: "TASKS", icon: ListChecks, path: "/tasks" },
  { id: "connect", label: "CONNECT", icon: Plug, path: "/connect" },
  { id: "mirror", label: "MIRROR", icon: Eye, path: "/mirror" },
  { id: "setting", label: "SETTING", icon: Settings, path: "/setting" },
] as const;

const CONVERSATION_PATH = "/conversation";

/** Setting subpages keep the SETTING nav item highlighted. */
const SETTING_SUBPATHS = new Set([
  "/subscription",
  "/notifications",
  "/preferences",
]);

export default function ZebraShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, signOut } = useAuth();

  const isConversation = location.pathname === CONVERSATION_PATH;
  // The conversation is an overlay: remember the last main view so it stays
  // rendered underneath (mirrors the iOS sheet over the persistent shell).
  const lastMainPath = useRef("/now");
  useEffect(() => {
    if (!isConversation) lastMainPath.current = location.pathname;
  }, [location.pathname, isConversation]);
  const mainPath = isConversation ? lastMainPath.current : location.pathname;

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [convExpanded, setConvExpanded] = useState(false);
  // Browser split (live view beside the chat) widens the conversation panel
  // to full width, like focus mode. Driven up from ConversationView.
  const [convBrowserSplit, setConvBrowserSplit] = useState(false);
  const [selectedCard, setSelectedCard] = useState<Intent | null>(null);
  const [approvePending, setApprovePending] = useState(false);
  const [activeChat, setActiveChat] = useState<{ card: IntentCard; bootstrap?: string } | null>(null);
  const [tasksChatTarget, setTasksChatTarget] = useState<{ cardId: string; bootstrap?: string } | null>(null);

  // Sidebar collapses to a 64px icon rail on narrow windows; ⌘B toggles it
  // manually, and crossing the breakpoint re-asserts the automatic state.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => window.matchMedia("(max-width: 1100px)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1100px)");
    const onChange = (e: MediaQueryListEvent) => setSidebarCollapsed(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  /* ── 真实数据：cards / actions / settings / weather ── */
  const cardsState = useCardsQuery();
  const composio = useComposio();
  // onOpenChat 的路由：/tasks 上下文里执行位是右 pane（提升给
  // ZebraTasksSplit），其余场景打开全局 card chat slide-over。
  const locationPathRef = useRef(location.pathname);
  useEffect(() => {
    locationPathRef.current = location.pathname;
  }, [location.pathname]);
  const cardActions = useCardActions({
    onOpenChat: (card, bootstrap) => {
      if (locationPathRef.current === "/tasks") {
        setTasksChatTarget({ cardId: card.id, bootstrap: bootstrap || undefined });
        return;
      }
      setSelectedCard(null);
      setActiveChat({ card, bootstrap: bootstrap || undefined });
    },
    composio,
  });
  const { settings, patch: patchSettings } = useUserSettings(user?.id ?? null);
  const weather = useWeather();
  const [ambientBusy, setAmbientBusy] = useState(false);

  // Debug panel（受控）：pipeline run state 驱动 generate / 进度展示；sidebar
  // 自画 debug icon 控制开关。run state 不持久化（debug 工具，无需跨刷新）。
  const pipeline = usePipeline();
  const [debugOpen, setDebugOpen] = useState(false);
  const handleDeleteAccount = useCallback(async () => {
    await deleteAccount();
    await signOut();
  }, [signOut]);

  // web 端 ambient 语义：镜像服务端 consent（手机侧采集的主开关）。
  const ambientOn = settings
    ? Object.values(settings.ambientSources ?? {}).some((c) => c?.enabled === true)
    : false;

  const onToggleAmbient = useCallback(async () => {
    if (!settings || ambientBusy) return;
    const sources = settings.ambientSources ?? {};
    const keys = Object.keys(sources);
    if (keys.length === 0) {
      toast.info("Set up Ambient on your phone first — the web mirrors its consent.");
      return;
    }
    setAmbientBusy(true);
    try {
      const next = !ambientOn;
      await patchSettings({
        ambientSources: Object.fromEntries(
          keys.map((k) => [k, { ...sources[k], enabled: next }]),
        ),
      });
    } catch (err) {
      console.warn("[ambient] consent toggle failed:", err);
      toast.error("Couldn't update ambient settings.");
    } finally {
      setAmbientBusy(false);
    }
  }, [settings, ambientBusy, ambientOn, patchSettings]);

  // Sphere cards are a pure projection of real backend cards（与
  // proactive-ai-frontend AppLayout 的投影完全一致）：intentKey 去重、
  // 隐藏 dismissed/done/hidden outcome、上限 14、状态 = 服务端 run
  // state + 乐观 processing 合成。
  const sphereCards: Intent[] = useMemo(() => {
    const seenIntentKeys = new Set<string>();
    return cardsState.cards
      .filter(
        (c) =>
          !cardActions.dismissedIds.has(c.card.id) &&
          !cardActions.doneIds.has(c.card.id) &&
          !isHiddenCardOutcome(c.latestOutcome),
      )
      .filter((c) => {
        const key = c.card.intentKey || c.card.id;
        if (seenIntentKeys.has(key)) return false;
        seenIntentKeys.add(key);
        return true;
      })
      .slice(0, 14)
      .map((c) => {
        const status: CardStatus = deriveCardUiStatus({
          runStatus: c.runStatus,
          latestOutcome: c.latestOutcome,
          optimisticProcessing: cardActions.processingIds.has(c.card.id),
          chatted: cardActions.chattedIds.has(c.card.id),
        });
        return realCardToLovableIntent(c.card, status);
      });
  }, [
    cardsState.cards,
    cardActions.dismissedIds,
    cardActions.doneIds,
    cardActions.processingIds,
    cardActions.chattedIds,
  ]);

  /** Intent.originalId → 真实 IntentCard（动作 POST 用原始卡）。 */
  const findRealCard = useCallback(
    (intent: Intent): IntentCard | null =>
      cardsState.cards.find((c) => c.card.id === intent.originalId)?.card ?? null,
    [cardsState.cards],
  );

  /* ── Panel orchestration — one slide-over at a time ── */
  const handleCardTap = useCallback((card: Intent) => {
    setSelectedCard(card);
  }, []);

  const handleApprove = useCallback(async (card: Intent) => {
    const real = findRealCard(card);
    if (!real) return;
    setApprovePending(true);
    try {
      await cardActions.confirm(real);
      setSelectedCard(null);
    } finally {
      setApprovePending(false);
    }
  }, [cardActions, findRealCard]);

  const handleDismiss = useCallback((card: Intent) => {
    const real = findRealCard(card);
    setSelectedCard(null);
    if (real) void cardActions.dismiss(real);
  }, [cardActions, findRealCard]);

  const handleComplete = useCallback(async (card: Intent) => {
    const real = findRealCard(card);
    if (!real) return;
    const persisted = await cardActions.complete(real);
    if (persisted) setSelectedCard(null);
    else toast.error("Couldn't mark the card done — try again.");
  }, [cardActions, findRealCard]);

  const handleChat = useCallback((card: Intent) => {
    const real = findRealCard(card);
    if (real) cardActions.openChat(real);
    setSelectedCard(null);
  }, [cardActions, findRealCard]);

  const closePanel = useCallback(() => {
    if (activeChat) setActiveChat(null);
    else if (selectedCard) setSelectedCard(null);
    else if (isConversation) navigate(lastMainPath.current);
  }, [activeChat, selectedCard, isConversation, navigate]);

  // ⌘K command palette, ⌘B sidebar, Escape closes topmost layer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setSidebarCollapsed((v) => !v);
        return;
      }
      if (e.key === "Escape") {
        if (paletteOpen) {
          setPaletteOpen(false);
          return;
        }
        closePanel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closePanel, paletteOpen]);

  // Leaving the conversation resets focus mode + browser split.
  useEffect(() => {
    if (!isConversation) {
      setConvExpanded(false);
      setConvBrowserSplit(false);
    }
  }, [isConversation]);

  /* ── ⌘K palette card entries（真实球面卡） ── */
  const paletteCards: PaletteCard[] = useMemo(
    () =>
      sphereCards.map((c) => {
        const cat = CATEGORIES[c.category] ?? CATEGORIES.life;
        return {
          id: String(c.id),
          title: c.title,
          icon: cat.icon,
          categoryLabel: cat.label,
          searchText: `${c.tag ?? ""} ${c.line1}`,
        };
      }),
    [sphereCards],
  );

  /* ── Active panel (mutually exclusive) ── */
  const panel = activeChat
    ? { key: `chat-${activeChat.card.id}`, width: 560, kind: "chat" as const }
    : selectedCard
      ? { key: `detail-${selectedCard.id}`, width: 440, kind: "detail" as const }
      : isConversation
        ? { key: "conversation", width: 560, kind: "conversation" as const }
        : null;

  /* ── Global execution awareness — sidebar TASKS badge ── */
  const runningCount = useMemo(() => {
    let n = 0;
    for (const c of cardsState.cards) {
      const ui = deriveCardUiStatus({
        runStatus: c.runStatus,
        latestOutcome: c.latestOutcome,
        optimisticProcessing: cardActions.processingIds.has(c.card.id),
        chatted: cardActions.chattedIds.has(c.card.id),
      });
      if (
        ui === "processing" &&
        !cardActions.dismissedIds.has(c.card.id) &&
        !cardActions.doneIds.has(c.card.id)
      ) {
        n += 1;
      }
    }
    return n;
  }, [
    cardsState.cards,
    cardActions.processingIds,
    cardActions.chattedIds,
    cardActions.dismissedIds,
    cardActions.doneIds,
  ]);

  const displayName =
    (user?.user_metadata?.full_name as string | undefined) ||
    user?.email?.split("@")[0] ||
    "there";
  const avatarLetter = displayName.charAt(0).toUpperCase();

  return (
    <div className="relative h-screen w-full overflow-hidden">
      <ZebraBackdrop />

      {/* Floating glass sidebar — collapses to a 64px icon rail (auto below
          1100px, ⌘B manual) */}
      <motion.aside
        animate={{ width: sidebarCollapsed ? 64 : 216 }}
        transition={SLIDE_TRANSITION}
        className="absolute left-5 top-5 bottom-5 z-30 rounded-3xl flex flex-col overflow-hidden"
        style={{
          background: "linear-gradient(180deg, hsl(0 0% 100% / 0.7) 0%, hsl(0 0% 100% / 0.55) 100%)",
          backdropFilter: "blur(48px) saturate(1.5)",
          WebkitBackdropFilter: "blur(48px) saturate(1.5)",
          border: "1px solid hsl(0 0% 100% / 0.5)",
          boxShadow: "0 8px 32px hsl(280 20% 60% / 0.08)",
        }}
      >
        {/* Brand + collapse toggle */}
        <div className={`flex items-center pt-6 pb-5 ${sidebarCollapsed ? "flex-col gap-3" : "gap-2.5 px-5"}`}>
          <span
            className="w-2.5 h-2.5 rounded-full shrink-0"
            style={{ background: "linear-gradient(135deg, hsl(var(--primary)) 0%, hsl(330 80% 65%) 100%)" }}
          />
          {!sidebarCollapsed && (
            <span className="text-bodySm font-bold tracking-[0.22em] text-foreground/80 flex-1 whitespace-nowrap">
              PIN AI
            </span>
          )}
          <button
            onClick={() => setSidebarCollapsed((v) => !v)}
            className="p-1.5 rounded-lg hover:bg-foreground/[0.06] text-foreground/40 hover:text-foreground/70 transition-colors"
            aria-label="Toggle sidebar"
            title="Toggle sidebar (⌘B)"
          >
            {sidebarCollapsed ? (
              <PanelLeft size={15} strokeWidth={1.8} />
            ) : (
              <PanelLeftClose size={15} strokeWidth={1.8} />
            )}
          </button>
        </div>

        {/* Nav */}
        <nav className={`flex flex-col gap-1 ${sidebarCollapsed ? "px-2.5" : "px-3"}`}>
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive =
              mainPath === item.path ||
              (item.id === "setting" && SETTING_SUBPATHS.has(mainPath));
            return (
              <button
                key={item.id}
                onClick={() => {
                  setSelectedCard(null);
                  setActiveChat(null);
                  navigate(item.path);
                }}
                className={`relative flex items-center rounded-xl transition-all text-left ${
                  sidebarCollapsed ? "justify-center p-3" : "gap-3 px-4 py-3"
                } ${isActive ? "bg-foreground/8 text-foreground" : "text-foreground/50 hover:bg-foreground/4"}`}
                title={sidebarCollapsed ? item.label : undefined}
              >
                <Icon size={18} strokeWidth={isActive ? 2 : 1.5} className="shrink-0" />
                {!sidebarCollapsed && (
                  <span className={`text-sm tracking-wider whitespace-nowrap ${isActive ? "font-semibold" : "font-medium"}`}>
                    {item.label}
                  </span>
                )}
                {item.id === "tasks" && runningCount > 0 && !sidebarCollapsed && (
                  <span className="ml-auto min-w-[18px] h-[18px] px-1 rounded-full bg-amber-500/90 text-white text-micro font-bold flex items-center justify-center tabular-nums">
                    {runningCount}
                  </span>
                )}
                {item.id === "tasks" && runningCount > 0 && sidebarCollapsed && (
                  <span className="absolute top-1 right-1 min-w-[15px] h-[15px] px-0.5 rounded-full bg-amber-500/90 text-white text-micro font-bold flex items-center justify-center tabular-nums ring-2 ring-white/80">
                    {runningCount}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Bottom cluster — debug trigger sits just above the user card */}
        <div className="mt-auto mb-3 flex flex-col gap-1.5">
        {/* Debug panel trigger — same gear/inspector the iOS nav exposes,
            here as a sidebar entry above the account (opens DebugPanel). */}
        <button
          onClick={() => setDebugOpen(true)}
          className={`flex items-center rounded-xl text-left text-foreground/45 hover:bg-foreground/4 hover:text-foreground/70 transition-all ${
            sidebarCollapsed ? "justify-center p-3 mx-2.5" : "gap-3 px-4 py-2.5 mx-3"
          }`}
          title="Debug panel"
          aria-label="Open debug panel"
        >
          <Bug size={17} strokeWidth={1.6} className="shrink-0" />
          {!sidebarCollapsed && (
            <Text variant="bodySm" weight="medium" className="tracking-wide">Debug</Text>
          )}
        </button>

        {/* User card — real session identity */}
        <div
          className={`flex items-center rounded-2xl ${
            sidebarCollapsed
              ? "mx-auto p-1"
              : "mx-3 gap-2.5 px-3 py-2.5 bg-foreground/[0.04] border border-foreground/[0.05]"
          }`}
        >
          <div
            className="w-8 h-8 rounded-xl text-white text-bodySm font-semibold flex items-center justify-center shrink-0"
            style={{ background: "linear-gradient(135deg, hsl(var(--primary)) 0%, hsl(330 80% 65%) 100%)" }}
          >
            {avatarLetter}
          </div>
          {!sidebarCollapsed && (
            <div className="flex-1 min-w-0">
              <Text variant="bodySm" weight="semibold" className="block text-foreground leading-tight truncate">{displayName}</Text>
              <Text variant="micro" className="block text-foreground/45 leading-tight truncate">{user?.email}</Text>
            </div>
          )}
        </div>
        </div>
      </motion.aside>

      {/* Main view — parallax-shifts slightly when a panel is open (iOS push depth cue) */}
      <motion.main
        animate={{ x: panel ? -16 : 0, paddingLeft: sidebarCollapsed ? 104 : 256 }}
        transition={SLIDE_TRANSITION}
        className="relative z-10 h-full"
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={mainPath}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="h-full"
          >
            {mainPath === "/tasks" ? (
              <ZebraTasksSplit
                entries={cardsState.cards}
                cardActions={cardActions}
                chatTarget={tasksChatTarget}
                onConsumeChatTarget={() => setTasksChatTarget(null)}
              />
            ) : mainPath === "/ambient" ? (
              <ZebraAmbient
                ambientOn={ambientOn}
                onConnectMore={() => navigate("/connect")}
              />
            ) : mainPath === "/connect" ? (
              <ZebraConnect composio={composio} />
            ) : mainPath === "/mirror" ? (
              <ZebraMirror composio={composio} />
            ) : mainPath === "/setting" ? (
              <ZebraSetting />
            ) : mainPath === "/subscription" ? (
              <ZebraSubscription />
            ) : mainPath === "/notifications" ? (
              <ZebraNotifications />
            ) : mainPath === "/preferences" ? (
              <ZebraPreferences />
            ) : (
              <ZebraNow
                displayName={displayName}
                sphereCards={sphereCards}
                cardsLoading={cardsState.loading}
                ambientOn={ambientOn}
                ambientBusy={ambientBusy}
                onToggleAmbient={() => void onToggleAmbient()}
                weather={weather}
                onAskPinAi={() => navigate(CONVERSATION_PATH)}
                onCardTap={handleCardTap}
              />
            )}
          </motion.div>
        </AnimatePresence>
      </motion.main>

      {/* Right slide-over panels */}
      <AnimatePresence>
        {panel && (
          <motion.div
            key="panel-scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="fixed inset-0 z-40 bg-foreground/5 backdrop-blur-[2px]"
            onClick={closePanel}
          />
        )}
        {panel && (
          <motion.div
            key={panel.key}
            initial={{ x: "calc(100% + 24px)" }}
            animate={{ x: 0 }}
            exit={{ x: "calc(100% + 24px)" }}
            transition={SLIDE_TRANSITION}
            className="fixed top-4 right-4 bottom-4 z-50 rounded-3xl overflow-hidden"
            style={{
              width:
                panel.kind === "conversation" && (convExpanded || convBrowserSplit)
                  ? "calc(100vw - 2rem)"
                  : `min(${panel.width}px, calc(100vw - 2rem))`,
              transition: "width 0.42s cubic-bezier(0.32, 0.72, 0, 1)",
              background: "linear-gradient(180deg, hsla(0, 0%, 100%, 0.55) 0%, hsla(0, 0%, 100%, 0.82) 100%)",
              backdropFilter: "blur(40px) saturate(1.5)",
              WebkitBackdropFilter: "blur(40px) saturate(1.5)",
              border: "1px solid hsla(0, 0%, 100%, 0.4)",
              boxShadow: "0 24px 64px hsl(280 20% 40% / 0.18)",
            }}
          >
            {panel.kind === "chat" && activeChat ? (
              <ZebraCardChat
                card={activeChat.card}
                bootstrap={activeChat.bootstrap}
                onBack={() => setActiveChat(null)}
                onOpenDetail={() => {
                  const status =
                    sphereCards.find((c) => c.originalId === activeChat.card.id)?.status ?? "normal";
                  setActiveChat(null);
                  setSelectedCard(realCardToLovableIntent(activeChat.card, status));
                }}
                onDone={async () => {
                  const ok = await cardActions.complete(activeChat.card);
                  if (ok) setActiveChat(null);
                  return ok;
                }}
                onComment={(text) => cardActions.textFeedback(activeChat.card, text)}
                onTurnDone={() => {
                  cardActions.clearProcessing(activeChat.card.id);
                  void cardsState.refresh();
                }}
              />
            ) : panel.kind === "detail" && selectedCard ? (
              <ZebraCardDetailPanel
                card={selectedCard}
                completed={cardActions.doneIds.has(selectedCard.originalId ?? "")}
                pending={approvePending}
                onClose={() => setSelectedCard(null)}
                onExecute={(c) => void handleApprove(c)}
                onDismiss={handleDismiss}
                onComplete={(c) => void handleComplete(c)}
                onChat={handleChat}
              />
            ) : panel.kind === "conversation" ? (
              <ZebraConversationPanel
                onClose={() => navigate(lastMainPath.current)}
                expanded={convExpanded}
                onToggleExpand={() => setConvExpanded((v) => !v)}
                onBrowserSplitChange={setConvBrowserSplit}
              />
            ) : null}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ⌘K command palette */}
      <ZebraCommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        cards={paletteCards}
        navItems={NAV_ITEMS}
        onSelectCard={(id) => {
          const card = sphereCards.find((c) => String(c.id) === id);
          if (card) handleCardTap(card);
        }}
        onAskPinAi={() => navigate(CONVERSATION_PATH)}
        onToggleAmbient={() => void onToggleAmbient()}
        onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
        onNavigate={(p) => navigate(p)}
      />

      {/* Debug panel — controlled by the sidebar trigger above the account
          card; hides its own gear (hideTrigger). Same panel the iOS nav opens. */}
      <DebugPanel
        open={debugOpen}
        onOpenChange={setDebugOpen}
        hideTrigger
        run={pipeline.run}
        isRunning={pipeline.isRunning}
        onGenerate={() => pipeline.generate()}
        composio={composio}
        onDeleteAccount={handleDeleteAccount}
      />
    </div>
  );
}
