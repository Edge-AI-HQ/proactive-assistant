import {
  useState,
  useEffect,
  useCallback,
  useRef,
  Suspense,
  type CSSProperties,
  type PointerEvent,
  type TouchEvent,
} from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import {
  Menu, Zap, ListChecks, Settings, Pencil, Plug,
  ArrowRight, ChevronDown, Check, Cloud,
  MapPin, Sun, Activity, Users, ChevronUp, Target,
} from "lucide-react";
import bgGradient from "@/assets/bg-gradient.jpg";
import AiSphere from "@/components/now/AiSphere";

import ConnectPanel from "@/components/connect/ConnectPanel";
import { type TimelineEntry as AmbientTimelineEntry } from "@/components/ambient/AmbientView";
import { type ChatCard, brandSvg, detectToolIcon } from "@/components/chat/ChatDetailView";
import { useCardExecutionRun } from "@/hooks/useCardExecutionRun";
import CardChat from "@/components/chat/CardChat";
import { deleteAccount, DeleteAccountError } from "@/lib/api";
import DebugPanel from "@/components/common/DebugPanel";
import AgentRunIndicator from "@/components/common/AgentRunIndicator";
import { CardStateProvider } from "@/components/card/CardStateContext";
import { useAuth } from "@/hooks/useAuth";
import { useCardActions } from "@/hooks/useCardActions";
import {
  isCompletedCardOutcome,
  isHiddenCardOutcome,
  useCards,
} from "@/hooks/useCards";
import { useComposio } from "@/hooks/useComposio";
import { useVoicePermission } from "@/hooks/useVoicePermission";
import { usePipeline } from "@/hooks/usePipeline";
import { usePushNotifications } from "@/hooks/usePushNotifications";
import { useUserSettings } from "@/hooks/useUserSettings";
import { useWeather } from "@/hooks/useWeather";
import { PreNotificationPrompt } from "@/components/common/PreNotificationPrompt";
import { isNative } from "@/lib/platform";
import type { GoalBasket, IntentCard } from "@/types/intent-card";
import { useAmbientLiveSession } from "@/hooks/useAmbientLiveSession";
import { useAmbientToggle } from "@/hooks/useAmbientToggle";
import type { LiveSession } from "@/services/ambient/live-session";
import {
  isFromRightEdgeOfScreen,
  isMainChatEntrySwipeUp,
  isMainMenuSwipeLeft,
  shouldIgnoreMainMenuSwipeTarget,
  type TouchPoint,
} from "@/components/chat/main-chat-entry-gesture";
import { useAppNavigation, type MenuId } from "@/components/app/useAppNavigation";
import LiveOverlay from "@/components/ambient/LiveOverlay";
import MainChatOverlay from "@/components/chat/MainChatOverlay";
import SideMenu from "@/components/app/SideMenu";
import CardDrawer from "@/components/card/CardDrawer";
import PaywallDrawer from "@/components/account/PaywallDrawer";
import ViewRouter from "@/components/app/ViewRouter";
import {
  realCardToLovableIntent,
  type Intent,
  type CardStatus,
} from "@/components/now/card-model";


const CONSTELLATION_HEADER_TOP =
  "max(4.5rem, calc(max(env(safe-area-inset-top, 0px), var(--safe-top, 0px)) + 0.75rem))";
const constellationShellStyle = {
  "--constellation-header-top": CONSTELLATION_HEADER_TOP,
} as CSSProperties;

/* ── Main component ── */
export default function AppLayout() {
  // Navigation state + unified goBack() live in useAppNavigation (phase-1
  // god-component extraction). Bottom-sheet drawers (selectedCard /
  // drawerOpen / paywallCard) stay local — their Intent type isn't exported.
  const {
    activeView, menuOpen, chatTarget, activeChat, mainChatOpen, liveOverlay,
    settingsSubPage,
    navigateTo, setMenuOpen, openCardChat, closeCardChat, setActiveChat,
    openMainChat, closeMainChat, setMainChatOpen, setLiveOverlay,
    setSettingsSubPage, recordChatEntryView, goBack,
  } = useAppNavigation();
  const [selectedCard, setSelectedCard] = useState<Intent | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paywallCard, setPaywallCard] = useState<Intent | null>(null);
  const navigate = useNavigate();
  const weather = useWeather();
  const { user, signOut } = useAuth();
  // Single useUserSettings instance per component — two instances meant
  // two /settings GETs and two patches racing for notifyNewCards. The
  // hook below (line ~330) returns the full result; this destructure
  // reads the same state for ambient-consent gating.
  const userSettings = useUserSettings();
  // Shared with AmbientView via useAmbientToggle: settings patch +
  // localStorage + native lifecycle. A flip from either view stays
  // consistent because both consume the same /api/settings consent
  // (App.tsx's startAmbientUpload effect rebinds on that field).
  const {
    ambientOn,
    togglePending: ambientTogglePending,
    toggle: handleToggleAmbient,
  } = useAmbientToggle();
  const { session: liveSession } = useAmbientLiveSession({
    ambientOn,
    enableWebDemo: false,
    dismissible: false,
  });
  const [isScrolled, setIsScrolled] = useState(false);
  const mainChatEntryPointerStartRef = useRef<TouchPoint | null>(null);
  const handleMainChatEntryPointerDown = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    mainChatEntryPointerStartRef.current = {
      x: event.clientX,
      y: event.clientY,
    };
  }, []);
  // Try to open main chat from an in-progress swipe. Returns whether the
  // gesture fired. Importantly, DOES NOT clear the start ref when the
  // threshold hasn't been crossed yet — clearing it on every pointermove
  // breaks iOS, where many tiny move events fire before the user reaches
  // 36px of vertical travel. The first sub-threshold move would null
  // the ref, so subsequent moves saw start=null and could never fire.
  // Web/desktop didn't show this because mouse moves produce fewer, larger
  // event deltas — the single move was often already past threshold.
  const openMainChatFromEntrySwipe = useCallback((
    end: TouchPoint,
    event: { preventDefault: () => void },
  ) => {
    if (!isMainChatEntrySwipeUp(mainChatEntryPointerStartRef.current, end)) return;
    mainChatEntryPointerStartRef.current = null;
    event.preventDefault();
    openMainChat();
  }, [openMainChat]);
  const handleMainChatEntryPointerUp = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    openMainChatFromEntrySwipe({
      x: event.clientX,
      y: event.clientY,
    }, event);
    // pointerup is the gesture's terminal state — clear regardless of
    // whether the swipe fired so the next gesture starts clean.
    mainChatEntryPointerStartRef.current = null;
  }, [openMainChatFromEntrySwipe]);
  const handleMainChatEntryPointerMove = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    openMainChatFromEntrySwipe({
      x: event.clientX,
      y: event.clientY,
    }, event);
  }, [openMainChatFromEntrySwipe]);
  const handleMainChatEntryTouchStart = useCallback((event: TouchEvent<HTMLButtonElement>) => {
    const touch = event.touches[0];
    if (!touch) return;
    mainChatEntryPointerStartRef.current = {
      x: touch.clientX,
      y: touch.clientY,
    };
  }, []);
  const handleMainChatEntryTouchMove = useCallback((event: TouchEvent<HTMLButtonElement>) => {
    const touch = event.touches[0];
    if (!touch) return;
    openMainChatFromEntrySwipe({
      x: touch.clientX,
      y: touch.clientY,
    }, event);
  }, [openMainChatFromEntrySwipe]);
  const handleMainChatEntryTouchEnd = useCallback((event: TouchEvent<HTMLButtonElement>) => {
    const touch = event.changedTouches[0];
    if (touch) {
      openMainChatFromEntrySwipe({
        x: touch.clientX,
        y: touch.clientY,
      }, event);
    }
    // touchend is terminal — always clear so the next gesture starts clean.
    mainChatEntryPointerStartRef.current = null;
  }, [openMainChatFromEntrySwipe]);

  useEffect(() => {
    if (!mainChatOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMainChatOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mainChatOpen]);

  /** Real user display values (from Supabase). Falls back to email prefix. */
  const userMeta = user?.user_metadata as
    | { full_name?: string; name?: string; avatar_url?: string }
    | undefined;
  const fullName = userMeta?.full_name || userMeta?.name || "";
  const firstName = fullName ? fullName.split(" ")[0] : "";
  const emailPrefix = user?.email ? user.email.split("@")[0] : "";
  const displayName = firstName || emailPrefix || "there";
  const avatarLetter = (firstName || emailPrefix || "?").slice(0, 1).toUpperCase();

  // ── Real-backend integration (preserved card execution path) ──
  const cardsState = useCards({ cacheScope: user?.id ?? null });
  const refreshCards = cardsState.refresh;
  const composio = useComposio();
  // Empty-state nudges (NowView): count ACTIVE connectors + read mic
  // permission so we can show only the setup steps that are still missing.
  const connectorCount = composio.connections.filter(
    (c) => c.status === "ACTIVE",
  ).length;
  // Only treat "0 connectors" as a reason to nudge once we've actually
  // loaded the (configured) connector list — otherwise the pre-load empty
  // array would nag already-connected users.
  const connectorsKnown =
    !composio.statusLoading &&
    !composio.loadingConns &&
    composio.keyStatus?.configured === true;
  const {
    state: voiceState,
    request: requestVoicePermission,
    refresh: refreshVoicePermission,
  } = useVoicePermission();
  // Empty-state "Turn on voice": fire the OS mic prompt; on grant also flip
  // ambient on so sensing actually starts, otherwise route to the permissions
  // panel (the OS won't re-prompt once denied).
  const handleEnableVoice = useCallback(async () => {
    const next = await requestVoicePermission();
    if (next === "granted") {
      if (!ambientOn) await handleToggleAmbient();
    } else {
      navigateTo("account");
      setSettingsSubPage("ambient");
    }
  }, [requestVoicePermission, ambientOn, handleToggleAmbient, navigateTo, setSettingsSubPage]);
  const handleReviewPermissions = useCallback(() => {
    navigateTo("account");
    setSettingsSubPage("ambient");
  }, [navigateTo, setSettingsSubPage]);
  // Returning to the home view re-checks mic permission so the "Turn on
  // voice" nudge clears after the user grants it in the permissions panel
  // (an in-app navigation that doesn't background the app).
  useEffect(() => {
    if (activeView === "now") void refreshVoicePermission();
  }, [activeView, refreshVoicePermission]);
  const pipeline = usePipeline();
  // Notification permission flow. iOS OS state is a capability; the
  // product-level `notifyNewCards` preference is controlled by the
  // Notifications page switch. The effects below only decide when to
  // show/stamp the one-time permission pre-prompt.
  //
  //   * Sheet only opens when state is "prompt" — granted / denied skip
  //     it entirely (the second effect auto-stamps prompted_at so the
  //     skip doesn't keep firing on every cold start).
  const pushNotifications = usePushNotifications();
  const osPromptable = (
    pushNotifications.permissionState === "prompt"
    || pushNotifications.permissionState === "prompt-with-rationale"
  );
  const notifPromptShow = (
    isNative
    && pushNotifications.ready
    && userSettings.settings != null
    && userSettings.settings.notifyPermissionPromptedAt == null
    && osPromptable
  );
  // Auto-stamp prompted_at when state is already decided (granted /
  // denied at app boot, e.g. user previously installed and answered, or
  // an existing user from before the sheet existed). Without this the
  // notifPromptShow gate would still be null but `osPromptable` is
  // false — fine, sheet doesn't show — yet on next cold start we'd
  // re-evaluate the same condition. Stamp once and stop re-checking.
  useEffect(() => {
    if (!isNative || !pushNotifications.ready) return;
    if (!userSettings.settings) return;
    if (userSettings.settings.notifyPermissionPromptedAt != null) return;
    if (osPromptable) return;  // sheet will handle it
    void userSettings.patch({ notifyPermissionPrompted: true });
  }, [
    pushNotifications.ready, osPromptable,
    userSettings.settings, userSettings.patch,
  ]);
  const lastCompleteRunIdRef = useRef<string | null>(null);
  const cardActions = useCardActions({
    onOpenChat: (card, bootstrap) => {
      const trimmed = bootstrap.trim();
      openCardChat(card, trimmed.length > 0 ? trimmed : undefined);
      setDrawerOpen(false);
      setSelectedCard(null);
    },
    composio,
  });

  useEffect(() => {
    if (pipeline.run.status !== "complete" || !pipeline.run.runId) return;
    if (pipeline.run.runId === lastCompleteRunIdRef.current) return;
    lastCompleteRunIdRef.current = pipeline.run.runId;
    void refreshCards();
  }, [pipeline.run.runId, pipeline.run.status, refreshCards]);

  // Detect scroll on any descendant scroll container (capture phase catches them all)
  useEffect(() => {
    const onScroll = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (!target || typeof target.scrollTop !== "number") return;
      setIsScrolled(target.scrollTop > 4);
    };
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, []);

  // Reset scrolled state when changing views
  useEffect(() => {
    setIsScrolled(false);
  }, [activeView]);

  // Sphere cards are a pure projection of real backend cards. No local
  // mock timers run on the home screen.
  const [sphereCards, setSphereCards] = useState<Intent[]>([]);

  // Mirror real /api/cards into sphereCards (one-way sync). Replaces the
  // Lovable mock initial seed + the legacy add-new ticker. Status reflects
  // useCardActions' optimistic processing/done state.
  useEffect(() => {
    // De-dup by intentKey so the same intent regenerated across runs only
    // floats onto the sphere once. useCards is cross-run history with no
    // internal dedup; /cards returns completed_at DESC, so the first
    // occurrence of each intentKey is its latest run. Cards without an
    // intentKey fall back to their unique card.id and are never collapsed.
    const seenIntentKeys = new Set<string>();
    const next: Intent[] = cardsState.cards
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
        const status: CardStatus = cardActions.processingIds.has(c.card.id)
          ? "processing"
          : "normal";
        return realCardToLovableIntent(c.card, status);
      });
    setSphereCards(next);
  }, [
    cardsState.cards,
    cardActions.dismissedIds,
    cardActions.doneIds,
    cardActions.processingIds,
  ]);

  // Chat state
  const [cardChats, setCardChats] = useState<ChatCard[]>([]);
  const [chatMode, setChatMode] = useState<"confirm" | "modify" | "done" | "steer">("confirm");
  const mainMenuSwipeStartRef = useRef<TouchPoint | null>(null);
  const canOpenMenuFromMainSwipe = (
    !menuOpen
    && !mainChatOpen
    // Card chat (chatTarget / activeChat) KEEPS the right-edge → menu swipe,
    // matching the design where the edge strip stays active in card chat.
    // (Card chat's own back gesture is the LEFT edge, so they don't clash.)
    && !drawerOpen
    && !paywallCard
    && !liveOverlay
  );

  const openMenuFromMainSwipe = useCallback((
    end: TouchPoint,
    event: { preventDefault: () => void },
  ) => {
    if (!canOpenMenuFromMainSwipe) {
      mainMenuSwipeStartRef.current = null;
      return;
    }
    const shouldOpen = isMainMenuSwipeLeft(mainMenuSwipeStartRef.current, end);
    if (!shouldOpen) return;
    mainMenuSwipeStartRef.current = null;
    event.preventDefault();
    setMenuOpen(true);
  }, [canOpenMenuFromMainSwipe]);
  const handleMainSurfacePointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!canOpenMenuFromMainSwipe) return;
    // Edge-gesture-only model (iOS-style): only swipes starting in the
    // right-edge zone open the menu. Non-edge swipes belong to whatever
    // content is below (e.g. Sphere3DCards card drag).
    //
    // This handler is wired as onPointerDownCapture (CAPTURE PHASE) on
    // the JSX below — so it fires BEFORE Sphere3DCards' own onPointerDown.
    // That's the only way to win: Sphere3DCards' own handler also calls
    // setPointerCapture, so the bubble-phase ordering would otherwise
    // let the sphere claim the gesture first.
    const screenWidth = typeof window === "undefined" ? Infinity : window.innerWidth;
    if (!isFromRightEdgeOfScreen(event.clientX, screenWidth)) {
      // Not an edge gesture — let the event continue propagating to the
      // sphere (or whatever child is under the finger) so they can do
      // their normal drag handling.
      mainMenuSwipeStartRef.current = null;
      return;
    }
    // Edge gesture: STOP the event here. The sphere's onPointerDown will
    // not fire, so its draggingRef stays false and it won't track the
    // pointer at all. We then claim the pointer ourselves for the
    // upcoming pointermove/up so the sphere never sees them either.
    event.stopPropagation();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* setPointerCapture may throw in unusual env (jsdom etc.); ignore */
    }
    mainMenuSwipeStartRef.current = {
      x: event.clientX,
      y: event.clientY,
    };
  }, [canOpenMenuFromMainSwipe]);
  const handleMainSurfacePointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    openMenuFromMainSwipe({
      x: event.clientX,
      y: event.clientY,
    }, event);
  }, [openMenuFromMainSwipe]);
  const handleMainSurfacePointerUp = useCallback((event: PointerEvent<HTMLDivElement>) => {
    openMenuFromMainSwipe({
      x: event.clientX,
      y: event.clientY,
    }, event);
    mainMenuSwipeStartRef.current = null;
  }, [openMenuFromMainSwipe]);
  const handleMainSurfaceTouchStart = useCallback((event: TouchEvent<HTMLDivElement>) => {
    if (!canOpenMenuFromMainSwipe) return;
    const touch = event.touches[0];
    if (!touch) return;
    // Edge-gesture-only model — see handleMainSurfacePointerDown comment.
    // Wired as onTouchStartCapture (CAPTURE PHASE) so it fires before
    // the sphere's own touch/pointer handlers.
    const screenWidth = typeof window === "undefined" ? Infinity : window.innerWidth;
    if (!isFromRightEdgeOfScreen(touch.clientX, screenWidth)) {
      mainMenuSwipeStartRef.current = null;
      return;
    }
    // Edge gesture: stop here so the sphere doesn't receive touchstart.
    event.stopPropagation();
    mainMenuSwipeStartRef.current = {
      x: touch.clientX,
      y: touch.clientY,
    };
  }, [canOpenMenuFromMainSwipe]);
  const handleMainSurfaceTouchMove = useCallback((event: TouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0];
    if (!touch) return;
    openMenuFromMainSwipe({
      x: touch.clientX,
      y: touch.clientY,
    }, event);
  }, [openMenuFromMainSwipe]);
  const handleMainSurfaceTouchEnd = useCallback((event: TouchEvent<HTMLDivElement>) => {
    const touch = event.changedTouches[0];
    if (!touch) {
      mainMenuSwipeStartRef.current = null;
      return;
    }
    openMenuFromMainSwipe({
      x: touch.clientX,
      y: touch.clientY,
    }, event);
    mainMenuSwipeStartRef.current = null;
  }, [openMenuFromMainSwipe]);
  const resetMainMenuSwipe = useCallback(() => {
    mainMenuSwipeStartRef.current = null;
  }, []);

  // Sphere card status is driven entirely by the real backend now:
  //   • `cardsState.cards` (useCards / GET /api/cards, 30s poll)
  //   • `cardActions.processingIds` / `doneIds` / `dismissedIds`
  // The sync effect above recomputes sphereCards whenever any of those
  // change, so we don't keep a local clock here. The
  // previous Lovable-era `new → normal (10s) → processing → done (10s) →
  // removed (10s)` ticker was a mock-data lifecycle simulator; on real
  // cards it surfaced two visible bugs:
  //   1. A card the user just Approved showed a green "DONE" ring 10s
  //      later without the user ever confirming Done, because the
  //      ticker auto-promoted processing → done locally.
  //   2. The same ticker then dropped the card from sphereCards 10s
  //      after that, only for the next `cardsState.cards` poll to add
  //      it back, producing the 5 → 3 → 5 visible-count flicker.
  // Card transitions to terminal states must come from real user
  // actions (POST /feedback kind=done / dismiss) — never a local timer.
  // Old `add new card` and greeting intervals also lived here. They were
  // pure presentation timers, so the native home screen no longer runs them.

  const handleCardTap = (card: Intent) => {
    setSelectedCard(card);
    setDrawerOpen(true);
  };

  const handleExecute = useCallback((card: Intent) => {
    if (card.locked) {
      setDrawerOpen(false);
      setSelectedCard(null);
      setPaywallCard(card);
      return;
    }
    recordChatEntryView();
    // Real /api/cards path: drive our existing chat runtime (POST /feedback
    // → MainChatView SSE). cardActions.confirm calls onOpenChat which sets
    // chatTarget; the render branches on chatTarget to mount CardChat.
    if (card.originalId) {
      const real = cardsState.cards.find((c) => c.card.id === card.originalId)?.card;
      if (real) {
        void cardActions.confirm(real);
        return;
      }
    }
    // Legacy mock path; real cards use originalId above.
    setDrawerOpen(false);
    setSelectedCard(null);
    setSphereCards((prev) =>
      prev.map((c) =>
        c.id === card.id ? { ...c, status: "processing" as CardStatus, statusTimestamp: Date.now() } : c
      )
    );
    const chatCard = card as ChatCard;
    setCardChats((prev) => {
      if (prev.find((c) => c.id === chatCard.id)) return prev;
      return [chatCard, ...prev];
    });
    setChatMode("modify");
    setActiveChat(chatCard);
  }, [activeView, cardActions, cardsState.cards, recordChatEntryView]);

  /** Ambient Action handoff (B+ MVP, web-only).
   *  Wraps an AmbientTimelineEntry into a virtual IntentCard so the existing
   *  CardChat → MainChatView SSE runtime can carry the event into the cloud
   *  chat agent. sessionKey resolves to `card-thread-ambient-<entry.id>`,
   *  which keeps the backend on its existing card-mode prompt path without
   *  any server change. */
  const handleAmbientAction = useCallback((entry: AmbientTimelineEntry) => {
    if (!entry.action) return;
    const entryId = entry.id ?? `${entry.time}-${entry.title}`.replace(/\s+/g, "-").toLowerCase();
    const ambientCardId = `ambient-${entryId}`;
    const virtualCard: IntentCard = {
      id: ambientCardId,
      goalBasket: entry.action.goalBasket ?? "life",
      title: entry.title,
      whyNow: `Ambient event captured at ${entry.time} on ${entry.device.name}.`,
      summary: entry.body,
      primaryAction: { label: entry.action.label, type: "confirm" },
      secondaryActions: [],
      confidence: entry.confidenceLabel === "uncertain" ? 0.5 : 0.85,
      urgency: 0.5,
      importance: 0.6,
      sources: [entry.device.name, ...entry.tags],
      agentChain: ["ambient"],
      createdAt: new Date().toISOString(),
    };
    const bootstrap = [
      "The user clicked an action from an Ambient Timeline event.",
      "",
      "Event:",
      entry.title,
      entry.body,
      "",
      "Action:",
      entry.action.label,
      "",
      "Goal:",
      entry.action.goal,
    ].join("\n");
    setDrawerOpen(false);
    setSelectedCard(null);
    openCardChat(virtualCard, bootstrap);
  }, [openCardChat]);

  // Wired to both the Setting tab (AccountPanel, currently dormant) and the
  // Debug panel's "Delete Account" button. Throws DeleteAccountError on a
  // fail-fast abort (Supabase Auth or DB cascade) so the caller can surface
  // the message; external partial failures (composio / litellm / stripe /
  // browserbase / storage) come back as fields on the result, not
  // exceptions — the cascade still succeeded so we proceed to sign out.
  const handleDeleteAccount = useCallback(async () => {
    let result;
    try {
      result = await deleteAccount();
    } catch (err) {
      if (err instanceof DeleteAccountError && err.partial) {
        console.warn("Delete account partial state:", err.partial);
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
      console.warn("Delete account: non-fatal external failures", result);
    }
    // signOut clears local/session storage and reloads / — the actual
    // app-state flush.
    await signOut();
  }, [signOut]);

  const handleMenuNav = (id: MenuId) => {
    // navigateTo clears the card-chat overlays (activeChat + chatTarget) and
    // the menu in one shot — same effect as the previous inline resets, which
    // existed so opening the menu from inside ChatDetailView actually navigates
    // instead of leaving chatTarget populated.
    navigateTo(id);
  };

  /* ── "now" home view ── */
  const handleSphereCardTap = (id: number) => {
    const card = sphereCards.find((c) => c.id === id);
    if (!card) return;
    if (card.status === "processing" || card.status === "done") {
      // Real /api/cards path: route through `chatTarget` so
      // ChatDetailView receives `runId={card.id}` and
      // `useCardExecutionRun` actually fetches LangGraph history.
      // The legacy `activeChat` branch leaves runId undefined,
      // the hook bails out
      // at `if (!runId)`, no /chat-stream/history call ever
      // fires, and the page hangs at "TASK running · CONTEXT"
      // forever — which is exactly the empty-card pathology.
      if (card.originalId) {
        const real = cardsState.cards.find(
          (c) => c.card.id === card.originalId,
        )?.card;
        if (real) {
          // No bootstrap — user re-entering an existing run;
          // they want to see what's already there, not kick
          // a fresh agent turn.
          openCardChat(real);
          return;
        }
      }
      // Legacy mock fallback.
      const chatCard = card as ChatCard;
      setCardChats((prev) => prev.find((c) => c.id === chatCard.id) ? prev : [chatCard, ...prev]);
      recordChatEntryView();
      setChatMode(card.status === "done" ? "done" : "modify");
      setActiveChat(chatCard);
    } else {
      handleCardTap(card);
    }
  };

  // Card execution (chatTarget / legacy activeChat) and the proactive agent
  // view both mount the full-screen ConversationView *inside* this layout's
  // content area. Unlike main chat — a portal overlay (MainChatOverlay) that
  // covers the whole layout — these surfaces don't hide the layout's own
  // floating chrome. ConversationView already carries its own aurora
  // background, header and back button, so the top-right menu bar and the
  // bottom ASK PIN AI entry must step aside or they overlap that surface.
  const inFullscreenChat =
    chatTarget != null || activeChat != null || activeView === "proactive";

  return (
    <CardStateProvider value={{ cardsState, cardActions }}>
    <div
      className="relative h-screen w-full max-w-md mx-auto overflow-hidden"
      style={constellationShellStyle}
      onPointerDownCapture={handleMainSurfacePointerDown}
      onPointerMove={handleMainSurfacePointerMove}
      onPointerUp={handleMainSurfacePointerUp}
      onPointerCancel={resetMainMenuSwipe}
      onTouchStartCapture={handleMainSurfaceTouchStart}
      onTouchMove={handleMainSurfaceTouchMove}
      onTouchEnd={handleMainSurfaceTouchEnd}
      onTouchCancel={resetMainMenuSwipe}
    >
      {/* Background — aurora flow using existing palette */}
      <img src={bgGradient} alt="" className="absolute inset-0 w-full h-full object-cover opacity-60" aria-hidden="true" />
      <div className="absolute inset-0 aurora-layer aurora-layer-1" aria-hidden="true" />
      <div className="absolute inset-0 aurora-layer aurora-layer-2" aria-hidden="true" />
      <div className="absolute inset-0 aurora-layer aurora-layer-3" aria-hidden="true" />
      <div className="absolute inset-0 bg-white/35" />

      <div className="relative z-10 flex flex-col h-full">
        {/* Top bar — AgentRunIndicator + Chat (MainChat) + DebugPanel (gear)
            + hamburger. Same composition as the old AppShell. Hidden while a
            full-screen ConversationView (card execution / proactive) owns the
            content area — that surface carries its own header + back button, so
            this floating bar would otherwise overlap it (main chat avoids this
            by rendering as a portal overlay that covers the whole layout). */}
        {!inFullscreenChat && (
          <div
            className="absolute right-5 z-30 flex items-start gap-1.5"
            style={{ top: "var(--constellation-header-top)" }}
          >
            <AgentRunIndicator />
            <DebugPanel
              run={pipeline.run}
              isRunning={pipeline.isRunning}
              onGenerate={() => pipeline.generate()}
              composio={composio}
              onDeleteAccount={handleDeleteAccount}
            />
            <button
              onClick={() => setMenuOpen(true)}
              className={`p-2 rounded-full transition-all duration-200 ${
                isScrolled
                  ? "border border-foreground/12 bg-background/55 backdrop-blur-md shadow-sm hover:bg-background/75"
                  : "border border-transparent hover:bg-foreground/[0.04]"
              }`}
              aria-label="Open menu"
            >
              <Menu size={20} strokeWidth={1.5} className={isScrolled ? "text-foreground/65" : "text-foreground/55"} />
            </button>
          </div>
        )}

        {/* Card chat keeps just the hamburger menu (design: card chat shows
            the nav button; the full bar with agent indicator + debug is
            home-only). inFullscreenChat still hides the bottom ASK PIN AI. */}
        {(chatTarget || activeChat) && (
          <div
            className="absolute right-5 z-30"
            // Match ConversationView's header padding (safe-area + 12px) so the
            // hamburger sits level with the card title, not lower.
            style={{ top: "calc(env(safe-area-inset-top, 0px) + 12px)" }}
          >
            <button
              onClick={() => setMenuOpen(true)}
              className="p-2 rounded-full border border-transparent transition-all duration-200 hover:bg-foreground/[0.04]"
              aria-label="Open menu"
            >
              <Menu size={20} strokeWidth={1.5} className="text-foreground/55" />
            </button>
          </div>
        )}

        {/* Main content area */}
        <ViewRouter
          chatTarget={chatTarget}
          activeChat={activeChat}
          activeView={activeView}
          cardActions={cardActions}
          composio={composio}
          onCardChatBack={() => closeCardChat()}
          onProactiveBack={() => navigateTo("now")}
          displayName={displayName}
          sphereCards={sphereCards}
          ambientOn={ambientOn}
          ambientTogglePending={ambientTogglePending}
          weather={weather}
          feedLoading={cardsState.loading}
          connectorCount={connectorCount}
          connectorsKnown={connectorsKnown}
          voiceState={voiceState}
          onOpenAmbient={() => navigateTo("ambient")}
          onToggleAmbient={() => void handleToggleAmbient()}
          onEnableVoice={() => void handleEnableVoice()}
          onReviewPermissions={handleReviewPermissions}
          onSphereCardTap={handleSphereCardTap}
          onTasksOpenChat={(card, bootstrap) => {
            openCardChat(
              card,
              bootstrap && bootstrap.trim().length > 0 ? bootstrap : undefined,
            );
          }}
          onTasksOpenCardDetail={(card) => {
            const status: CardStatus = cardActions.processingIds.has(card.id)
              ? "processing"
              : "normal";
            setSelectedCard(realCardToLovableIntent(card, status));
            setDrawerOpen(true);
          }}
          onConnectMore={() => navigateTo("connect")}
          onOpenFullscreen={(s) => setLiveOverlay(s)}
          onAmbientAction={handleAmbientAction}
          settingsSubPage={settingsSubPage}
          onSubPageChange={setSettingsSubPage}
          userName={fullName || displayName}
          avatarLetter={avatarLetter}
          userEmail={user?.email ?? undefined}
          onSignOut={() => void signOut()}
          onDeleteAccount={handleDeleteAccount}
        />

        {/* ASK PIN AI — bottom-center entry into MainChat. Mirrors the
            minimalist constellation design (MinimalistNow): subtle pulse +
            ChevronUp + uppercase label. Suppressed during card execution
            (activeView stays "now" while chatTarget is set) so the arrow
            doesn't float over the card conversation surface. */}
        {activeView === "now" && !inFullscreenChat && (
          <button
            onClick={openMainChat}
            onPointerDown={handleMainChatEntryPointerDown}
            onPointerMove={handleMainChatEntryPointerMove}
            onPointerUp={handleMainChatEntryPointerUp}
            onPointerCancel={() => {
              mainChatEntryPointerStartRef.current = null;
            }}
            onTouchStart={handleMainChatEntryTouchStart}
            onTouchMove={handleMainChatEntryTouchMove}
            onTouchEnd={handleMainChatEntryTouchEnd}
            onTouchCancel={() => {
              mainChatEntryPointerStartRef.current = null;
            }}
            className="absolute left-1/2 -translate-x-1/2 z-30 flex flex-col items-center gap-1 px-3 py-1.5 touch-none select-none group"
            style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 16px)" }}
            aria-label="Open main chat"
          >
            <motion.div
              animate={{ y: [0, -4, 0], opacity: [0.45, 0.75, 0.45] }}
              transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut" }}
              className="flex items-center justify-center"
            >
              <ChevronUp size={18} strokeWidth={1.6} className="text-foreground/55 group-hover:text-foreground/80 transition-colors" />
            </motion.div>
            <span className="text-[10px] tracking-[0.18em] uppercase text-foreground/35 group-hover:text-foreground/60 transition-colors font-medium">
              Ask PIN AI
            </span>
          </button>
        )}

      </div>

      {/* Live session fullscreen overlay — rendered at root via portal, fully independent of activeView. */}
      <LiveOverlay
        liveOverlay={liveOverlay}
        liveSession={liveSession ?? null}
        onClose={() => setLiveOverlay(null)}
      />

      {/* Main chat overlay. Opened by the bottom-center ASK PIN AI button. */}
      <MainChatOverlay open={mainChatOpen} onBack={() => closeMainChat()} />

      {/* Hamburger side menu overlay */}
      <SideMenu
        open={menuOpen}
        activeView={activeView}
        activeChat={activeChat}
        onClose={() => setMenuOpen(false)}
        onNavigate={handleMenuNav}
      />

      {/* Card detail drawer */}
      <CardDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        card={selectedCard}
        completed={
          selectedCard?.originalId
            ? cardActions.doneIds.has(selectedCard.originalId) ||
              isCompletedCardOutcome(
                cardsState.cards.find(
                  (c) => c.card.id === selectedCard.originalId,
                )?.latestOutcome,
              )
            : false
        }
        pending={
          selectedCard?.originalId
            ? cardActions.processingIds.has(selectedCard.originalId)
            : false
        }
        onExecute={handleExecute}
        onClose={() => { setDrawerOpen(false); setSelectedCard(null); }}
        onDismiss={(card) => {
          setDrawerOpen(false);
          setSelectedCard(null);
          // Real card → POST /feedback kind=dismiss (useCardActions).
          if (card.originalId) {
            const real = cardsState.cards.find(
              (c) => c.card.id === card.originalId,
            )?.card;
            if (real) {
              void cardActions.dismiss(real);
              return;
            }
          }
        }}
        onModify={(card) => {
          setDrawerOpen(false);
          setSelectedCard(null);
          recordChatEntryView();
          // Real card → POST /feedback kind=card_action action=modify
          // and open the card-thread as the feedback / steer surface.
          if (card.originalId) {
            const real = cardsState.cards.find(
              (c) => c.card.id === card.originalId,
            )?.card;
            if (real) {
              void cardActions.modify(real);
              return;
            }
          }
          const chatCard = card as ChatCard;
          setCardChats((prev) => {
            if (prev.find((c) => c.id === chatCard.id)) return prev;
            return [chatCard, ...prev];
          });
          setChatMode("steer");
          navigateTo("chat");
          setActiveChat(chatCard);
        }}
      />

      {/* Paywall dialog — locked tasks require Pro to approve */}
      <PaywallDrawer card={paywallCard} onClose={() => setPaywallCard(null)} />

      <PreNotificationPrompt
        open={notifPromptShow}
        onAccept={async () => {
          const nextPermission = await pushNotifications.requestPermission();
          await userSettings.patch({
            notifyPermissionPrompted: true,
            ...(nextPermission === "granted" ? { notifyNewCards: true } : {}),
          });
        }}
        onDecline={async () => {
          await userSettings.patch({ notifyPermissionPrompted: true });
        }}
      />
    </div>
    </CardStateProvider>
  );
}

