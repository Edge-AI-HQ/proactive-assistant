import { useState, useEffect, useCallback, useRef, Suspense } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Menu, X, Zap, ListChecks, Settings, Pencil, Radio, Plug,
  Sprout, Briefcase, TrendingUp, Heart, BookOpen, Sparkles,
  ArrowRight, ChevronDown, Check, Cloud, Lock as LockIcon,
  MapPin, Sun, Activity, Users, ChevronUp, Target,
  type LucideIcon,
} from "lucide-react";
import bgGradient from "@/assets/bg-gradient.jpg";
import AiSphere from "./AiSphere";
import Sphere3DCards from "./Sphere3DCards";
import ChatTimeline from "./ChatTimeline";

import AccountPanel from "./AccountPanel";
import ConnectPanel from "./ConnectPanel";
import AmbientView, { LiveFullscreen, type TimelineEntry as AmbientTimelineEntry } from "./AmbientView";
import { createPortal } from "react-dom";
import ChatDetailView, { type ChatCard, brandSvg, detectToolIcon } from "./ChatDetailView";
import { DrawerDetailBody } from "./CardDrawerDetail";
import { useCardExecutionRun } from "@/hooks/useCardExecutionRun";
import { PlanPaymentForm, isPayValid, PLANS, type PlanId, type PayMethod, type CardInfo } from "./PlanPaymentForm";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";
import CardChat from "@/components/CardChat";
import { deleteAccount, DeleteAccountError } from "@/lib/api";
import DebugPanel from "@/components/DebugPanel";
import MainChat from "@/components/MainChat";
import AgentRunIndicator from "@/components/AgentRunIndicator";
import RealGoalsView from "@/components/GoalsView";
import RealControlPanel from "@/components/ControlPanel";
import RealChatTimeline from "@/components/ChatTimeline";
import { useAuth } from "@/hooks/useAuth";
import { useCardActions } from "@/hooks/useCardActions";
import {
  isCompletedCardOutcome,
  isHiddenCardOutcome,
  useCards,
} from "@/hooks/useCards";
import { useComposio } from "@/hooks/useComposio";
import { usePipeline } from "@/hooks/usePipeline";
import { usePushNotifications } from "@/hooks/usePushNotifications";
import { useUserSettings } from "@/hooks/useUserSettings";
import { useWeather } from "@/hooks/useWeather";
import { PreNotificationPrompt } from "@/components/PreNotificationPrompt";
import { isNative } from "@/lib/platform";
import type { GoalBasket, IntentCard } from "@/types/intent-card";
import { useAmbientLiveSession } from "@/hooks/useAmbientLiveSession";
import { useAmbientToggle } from "@/hooks/useAmbientToggle";
import type { LiveSession } from "@/services/ambient/live-session";

/** Stable string→number hash so real card.id (string) gets a numeric id for
 *  Lovable's sphere components without losing the original. */
function djb2(str: string): number {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
  return Math.abs(h | 0);
}

function basketToLovableCategory(basket: GoalBasket): string {
  switch (basket) {
    case "wealth": return "finance";
    case "family": return "life";
    default: return basket;
  }
}

/** Real IntentCard (from /api/cards) → Lovable Intent (visual). Carries
 *  originalId so handleExecute can recover the IntentCard for the chat runtime. */
/** IntentCard → ChatDetailView's ChatCard shape (Lovable-era visual
 *  contract used numeric ids + the same `detail` envelope). Only the
 *  fields ChatDetailView actually reads are populated; the real
 *  EXECUTION PLAN / drafts / dangerous_actions / risks come from the
 *  cached propose_action args via the hook, not from this static
 *  projection. The original string id rides separately via the `runId`
 *  prop so the hook can derive the chat-stream session_key. */
function realIntentToChatCard(card: IntentCard): ChatCard {
  return {
    id: djb2(card.id),
    category: basketToLovableCategory(card.goalBasket),
    tag: card.urgency >= 0.85 ? "Urgent" : undefined,
    title: card.title,
    line1: card.whyNow || card.summary,
    line2: card.sources.length > 0 ? `Sources: ${card.sources.join(" · ")}` : "",
    whyNow:
      card.whyNow && card.whyNow.trim() && card.whyNow !== card.summary
        ? card.whyNow
        : undefined,
    detail: {
      scores: [
        { label: "Confidence", value: Math.round(card.confidence * 100) },
        { label: "Importance", value: Math.round(card.importance * 100) },
        { label: "Urgency", value: Math.round(card.urgency * 100) },
      ],
      willExecute: card.primaryAction?.label ?? "",
      executionPlan: [],
      dataSources: card.sources,
      impact: "",
      permissions: "",
    },
  };
}

function realCardToLovableIntent(card: IntentCard, status: CardStatus): Intent {
  return {
    id: djb2(card.id),
    originalId: card.id,
    category: basketToLovableCategory(card.goalBasket),
    tag: card.urgency >= 0.85 ? "Urgent" : undefined,
    title: card.title,
    line1: card.whyNow || card.summary,
    line2: card.sources.length > 0 ? `Sources: ${card.sources.join(" · ")}` : "",
    // Preserved separately from line1 (which collapses whyNow / summary
    // into a single headline) so the drawer can render a dedicated
    // "WHY NOW" block — only fill when both fields exist AND differ, so
    // we don't duplicate the headline below it.
    whyNow:
      card.whyNow && card.whyNow.trim() && card.whyNow !== card.summary
        ? card.whyNow
        : undefined,
    detail: {
      scores: [
        { label: "Confidence", value: Math.round(card.confidence * 100) },
        { label: "Importance", value: Math.round(card.importance * 100) },
        { label: "Urgency", value: Math.round(card.urgency * 100) },
      ],
      willExecute: card.primaryAction.label,
      executionPlan: [],
      dataSources: card.sources,
      impact: "",
      permissions: "",
    },
    status,
    statusTimestamp: Date.now(),
  };
}

/* ── Lovable mock Intent → our real IntentCard (so the existing CardChat /
 * MainChatView runtime can consume Lovable's mock cards while the real
 * /cards backend isn't connected yet). Backend stays untouched. ── */
function intentCategoryToBasket(category: string): GoalBasket {
  switch (category) {
    case "growth":  return "growth";
    case "work":    return "work";
    case "finance": return "wealth";
    case "health":  return "health";
    case "learn":   return "growth";
    case "life":    return "life";
    default:        return "life";
  }
}

type AdaptableCard = Pick<
  Intent,
  "id" | "category" | "title" | "line1" | "line2" | "detail"
>;

function lovableIntentToIntentCard(intent: AdaptableCard): IntentCard {
  const scoreMap = new Map<string, number>(
    (intent.detail?.scores ?? []).map((s) => [s.label, s.value]),
  );
  const score = (label: string, fallback: number) =>
    (scoreMap.get(label) ?? fallback) / 100;
  const sources = (intent.line2 ?? "")
    .replace(/^Sources:\s*/i, "")
    .split(/[·,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    id: `lovable-${intent.id}`,
    goalBasket: intentCategoryToBasket(intent.category),
    title: intent.title,
    whyNow: intent.line1,
    summary: intent.line1,
    primaryAction: {
      label: intent.detail?.willExecute || intent.title,
      type: "confirm",
    },
    secondaryActions: [],
    confidence: score("Confidence", 80),
    urgency: score("Urgency", 80),
    importance: score("Importance", 80),
    sources,
    agentChain: [],
    createdAt: new Date().toISOString(),
  };
}

/* ── Card data (reused from NowFeed) ── */

interface ExecutionStep { text: string; tool: string; }
export interface Artifact {
  kind: "email" | "notes" | "message" | "doc";
  app: "gmail" | "slack" | "notion" | "gdocs";
  title: string;        // e.g. subject, channel, page name
  meta?: string;        // e.g. "To: alex@acme.com · Draft", "#finance · DM"
  body: string;         // multi-line content; \n preserved
}
interface DetailData {
  scores: { label: string; value: number }[];
  willExecute: string;
  executionPlan: ExecutionStep[];
  dataSources: string[];
  impact: string;
  permissions: string;
  result?: string;
  artifacts?: Artifact[];
}
type CardStatus = "normal" | "new" | "processing" | "done";
interface Intent {
  id: number;
  category: string;
  tag?: string;
  complexity?: "simple"; // marks quick-approve tasks (low risk, few steps)
  locked?: boolean; // requires Pro to approve
  title: string;
  line1: string;
  line2: string;
  /** Generator-side rationale; rendered as a dedicated "WHY NOW" block
   *  in CardDrawerContent → DrawerDetailBody. Optional because legacy
   *  Lovable mock entries don't carry it. */
  whyNow?: string;
  detail?: DetailData;
  status: CardStatus;
  statusTimestamp?: number; // when status was set
  /** Set when the card came from real /api/cards (string id). handleExecute
   *  uses it to look up the real IntentCard and feed our MainChatView runtime. */
  originalId?: string;
}

const CATEGORIES: Record<string, { icon: LucideIcon; label: string }> = {
  growth:  { icon: Sprout,      label: "Growth" },
  work:    { icon: Briefcase,   label: "Work" },
  finance: { icon: TrendingUp,  label: "Finance" },
  health:  { icon: Heart,       label: "Health" },
  learn:   { icon: BookOpen,    label: "Learn" },
  life:    { icon: Sparkles,    label: "Life" },
};

/* ── Hamburger side menu items ── */
const MENU_ITEMS = [
  { id: "now", label: "NOW", icon: Zap },
  { id: "ambient", label: "AMBIENT", icon: Radio },
  { id: "chat", label: "TASKS", icon: ListChecks },
  { id: "connect", label: "CONNECT", icon: Plug },
  { id: "profile", label: "PROFILE", icon: Target },
  { id: "account", label: "SETTING", icon: Settings },
] as const;
type MenuId = (typeof MENU_ITEMS)[number]["id"];

/* ── Main component ── */
export default function BigBallLayout() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeView, setActiveView] = useState<MenuId>("now");
  const [liveOverlay, setLiveOverlay] = useState<LiveSession | null>(null);
  const [selectedCard, setSelectedCard] = useState<Intent | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paywallCard, setPaywallCard] = useState<Intent | null>(null);
  const [paywallPlan, setPaywallPlan] = useState<PlanId>("pro");
  const [paywallPay, setPaywallPay] = useState<PayMethod | null>("apple");
  const [paywallCard_, setPaywallCardInfo] = useState<CardInfo>({ number: "", expiry: "", cvc: "" });
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
  const [mainChatOpen, setMainChatOpen] = useState(false);
  const handleMainChatBack = useCallback(() => {
    setActiveView("now");
    setMainChatOpen(false);
  }, []);

  useEffect(() => {
    if (!mainChatOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMainChatOpen(false);
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
  /** When set, ConstellationLayout renders our existing CardChat overlay
   *  (MainChatView + SSE chat-stream runtime). Replaces Lovable's mock
   *  ChatDetailView path. */
  const [chatTarget, setChatTarget] = useState<{
    card: IntentCard;
    bootstrap?: string;
  } | null>(null);
  const lastCompleteRunIdRef = useRef<string | null>(null);
  const cardActions = useCardActions({
    onOpenChat: (card, bootstrap) => {
      const trimmed = bootstrap.trim();
      setChatTarget({ card, bootstrap: trimmed.length > 0 ? trimmed : undefined });
      setDrawerOpen(false);
      setSelectedCard(null);
    },
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
    const next: Intent[] = cardsState.cards
      .filter(
        (c) =>
          !cardActions.dismissedIds.has(c.card.id) &&
          !cardActions.doneIds.has(c.card.id) &&
          !isHiddenCardOutcome(c.latestOutcome),
      )
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
  const [activeChat, setActiveChat] = useState<ChatCard | null>(null);
  const [chatMode, setChatMode] = useState<"confirm" | "modify" | "done" | "steer">("confirm");
  const chatEntryView = useRef<MenuId | null>(null);

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
    chatEntryView.current = activeView;
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
  }, [activeView, cardActions, cardsState.cards]);

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
    chatEntryView.current = "ambient";
    setDrawerOpen(false);
    setSelectedCard(null);
    setChatTarget({ card: virtualCard, bootstrap });
  }, []);

  const handleMenuNav = (id: MenuId) => {
    setActiveView(id);
    setActiveChat(null);
    // Without this, opening the side menu from inside ChatDetailView
    // (which is rendered iff `chatTarget` is set) leaves chatTarget
    // populated, and the main-content branch `chatTarget ? ChatDetailView
    // : activeChat ? ... : activeView` keeps rendering ChatDetailView —
    // the user sees the menu close but no navigation.
    setChatTarget(null);
    setMenuOpen(false);
  };

  /* ── "now" home view ── */
  const renderNowView = () => (
    <div className="relative flex flex-col h-full">
      {/* Greeting + Ambient (always) + Live (when active) */}
      <div className="relative z-20 px-5 pt-20 pb-3">
        {/* Greeting — generous space, editorial feel */}
        <h2 className="text-[30px] font-semibold tracking-tight text-foreground leading-[1.05]">
          Hi,{" "}
          <span className="bg-gradient-to-r from-[hsl(292,78%,63%)] to-[hsl(330,80%,65%)] bg-clip-text text-transparent">
            {displayName}
          </span>
        </h2>
        <p className="mt-1.5 text-[13px] text-foreground/50 leading-snug">
          Your proactive feed · {sphereCards.length} cards today
        </p>

        {/* Subtle divider */}
        <div className="mt-4 h-px bg-foreground/[0.08]" />

        {/* Ambient — left tap opens the Ambient tab; right pill toggles
            the master ambient switch (persisted to localStorage). When OFF
            the label says "Paused — not sensing" and the toggle dot slides
            left; when ON the "Ambient" word drifts purple via the
            ambient-drift keyframe and the dot slides right. */}
        <div className="w-full flex items-center gap-3 py-2.5">
          <button
            onClick={() => setActiveView("ambient")}
            className="flex items-center gap-3 flex-1 min-w-0 text-left group"
            aria-label="Open Ambient"
          >
            <span
              className={`text-[10px] font-semibold uppercase tracking-[0.18em] shrink-0 w-[60px] ${
                ambientOn ? "animate-ambient-drift" : "text-foreground/40"
              }`}
            >
              Ambient
            </span>
            <span
              className={`text-[13px] truncate flex-1 leading-snug transition-colors ${
                ambientOn ? "text-foreground/75" : "text-foreground/35"
              }`}
            >
              {!ambientOn
                ? "Paused — not sensing"
                : weather
                  ? `${weather.city} · ${weather.label} · ${weather.temp}°`
                  : "Quiet ambient — connect sources to start streaming signals"}
            </span>
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              void handleToggleAmbient();
            }}
            disabled={ambientTogglePending}
            className={`relative w-9 h-5 rounded-full transition-colors shrink-0 disabled:opacity-60 disabled:cursor-progress ${
              ambientOn ? "bg-foreground" : "bg-foreground/20"
            }`}
            aria-label="Toggle ambient"
            aria-pressed={ambientOn}
            aria-busy={ambientTogglePending}
          >
            <motion.span
              layout
              transition={{ type: "tween", duration: 0.2, ease: "easeInOut" }}
              className={`absolute top-0.5 w-4 h-4 rounded-full bg-background shadow-sm ${
                ambientOn ? "left-[18px]" : "left-0.5"
              }`}
            />
          </button>
        </div>
      </div>

      {/* 3D sphere of all cards — drag to rotate */}
      <div className="flex-1 relative overflow-hidden">
        <Sphere3DCards
          cacheKey="bigball2-now-sphere"
          cardWidth={160}
          cardHeight={68}
          items={sphereCards.map((c) => ({
            id: c.id,
            category: c.category,
            title: c.title,
            icon: CATEGORIES[c.category].icon,
            categoryLabel: CATEGORIES[c.category].label,
            complexity: c.complexity,
            status: c.status,
          }))}
          onCardTap={(id) => {
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
                  chatEntryView.current = activeView;
                  // No bootstrap — user re-entering an existing run;
                  // they want to see what's already there, not kick
                  // a fresh agent turn.
                  setChatTarget({ card: real, bootstrap: undefined });
                  return;
                }
              }
              // Legacy mock fallback.
              const chatCard = card as ChatCard;
              setCardChats((prev) => prev.find((c) => c.id === chatCard.id) ? prev : [chatCard, ...prev]);
              chatEntryView.current = activeView;
              setChatMode(card.status === "done" ? "done" : "modify");
              setActiveChat(chatCard);
            } else {
              handleCardTap(card);
            }
          }}
        />
      </div>
    </div>
  );

  return (
    <div className="relative h-screen w-full max-w-md mx-auto overflow-hidden">
      {/* Background — aurora flow using existing palette */}
      <img src={bgGradient} alt="" className="absolute inset-0 w-full h-full object-cover opacity-60" aria-hidden="true" />
      <div className="absolute inset-0 aurora-layer aurora-layer-1" aria-hidden="true" />
      <div className="absolute inset-0 aurora-layer aurora-layer-2" aria-hidden="true" />
      <div className="absolute inset-0 aurora-layer aurora-layer-3" aria-hidden="true" />
      <div className="absolute inset-0 bg-white/35" />

      <div className="relative z-10 flex flex-col h-full">
        {/* Top bar — AgentRunIndicator + Chat (MainChat) + DebugPanel (gear)
            + hamburger. Same composition as the old AppShell. */}
        <div className="absolute top-12 right-5 z-30 flex items-center gap-1.5">
          <AgentRunIndicator />
          <DebugPanel
            run={pipeline.run}
            isRunning={pipeline.isRunning}
            onGenerate={() => pipeline.generate()}
            composio={composio}
          />
          <button
            onClick={() => setMenuOpen(true)}
            className={`-mt-1 p-2 rounded-full transition-all duration-200 ${
              isScrolled
                ? "border border-foreground/12 bg-background/55 backdrop-blur-md shadow-sm hover:bg-background/75"
                : "border border-transparent hover:bg-foreground/[0.04]"
            }`}
            aria-label="Open menu"
          >
            <Menu size={20} strokeWidth={1.5} className={isScrolled ? "text-foreground/65" : "text-foreground/55"} />
          </button>
        </div>

        {/* Main content area */}
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={
              chatTarget
                ? `card-chat-${chatTarget.card.id}`
                : activeChat
                  ? `chat-detail-${activeChat.id}`
                  : activeView
            }
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="flex-1 overflow-hidden"
          >
            {chatTarget ? (
              /* Real card execution: the rich ChatDetailView (EXECUTION
                 timeline + Generated draft card + NEEDS YOUR INPUT pink
                 panel + Dismiss/Pause toolbar). Backed by the
                 chat-stream-adapter `useCardExecutionRun` hook —
                 session_key = `card-thread-<cardId>` so the propose_action
                 history persists on LangGraph's checkpointer. `bootstrap`
                 is the Confirm-path's primaryAction text; the hook auto-
                 fires it if the thread is empty (fanout missed it). */
              <ChatDetailView
                card={realIntentToChatCard(chatTarget.card)}
                runId={chatTarget.card.id}
                bootstrap={chatTarget.bootstrap}
                onBack={() => {
                  const returnTo = chatEntryView.current;
                  setChatTarget(null);
                  if (returnTo) setActiveView(returnTo);
                }}
                // Sphere → TASKS lifecycle: Dismiss / Done in the
                // chat toolbar must POST /feedback so the card moves
                // off the sphere (dismissedIds / doneIds filter) and
                // shows as Dismissed / Completed in the TASKS view.
                // Without these the hook's cancel/confirmDone are
                // purely local UI flips.
                onDismissBackend={() => {
                  return cardActions.dismiss(chatTarget.card);
                }}
                onDoneBackend={() => {
                  return cardActions.complete(chatTarget.card);
                }}
              />
            ) : activeChat ? (
              /* Legacy mock-card path. Kept so type-checking stays honest
                 if mock data is reintroduced for demos. */
              <ChatDetailView
                card={activeChat as ChatCard}
                onBack={() => {
                  const returnTo = chatEntryView.current;
                  setActiveChat(null);
                  if (returnTo) setActiveView(returnTo);
                }}
              />
            ) : activeView === "now" ? (
              renderNowView()
            ) : activeView === "chat" ? (
              /* Real card history (old AppShell CHAT view). Reuses the
                 shared /api/cards state from this layout so TASKS does not
                 refetch on every tab entry. */
              <RealChatTimeline
                cards={cardsState}
                processingIds={cardActions.processingIds}
                doneIds={cardActions.doneIds}
                confirmedIds={cardActions.confirmedIds}
                dismissedIds={cardActions.dismissedIds}
                chattedIds={cardActions.chattedIds}
                onOpenChat={(card, bootstrap) => {
                  chatEntryView.current = "chat";
                  setChatTarget({
                    card,
                    bootstrap:
                      bootstrap && bootstrap.trim().length > 0
                        ? bootstrap
                        : undefined,
                  });
                }}
                onOpenCardDetail={(card) => {
                  const status: CardStatus = cardActions.processingIds.has(card.id)
                    ? "processing"
                    : "normal";
                  setSelectedCard(realCardToLovableIntent(card, status));
                  setDrawerOpen(true);
                }}
                onConfirmId={cardActions.markConfirmed}
                onDismissId={cardActions.markDismissed}
                onDoneId={cardActions.markDone}
                onProcessingId={cardActions.markProcessing}
                onChattedId={cardActions.markChatted}
              />
            ) : activeView === "ambient" ? (
              <AmbientView
                onConnectMore={() => setActiveView("connect")}
                onOpenFullscreen={(s) => setLiveOverlay(s)}
                onAmbientAction={handleAmbientAction}
              />
            ) : activeView === "profile" ? (
              /* Real goals/memory/skill page (old AppShell GOALS view). */
              <div className="h-full min-h-0 overflow-hidden pt-12">
                <RealGoalsView composio={composio} />
              </div>
            ) : activeView === "connect" ? (
              /* Real data + device connections + auto settings (old AppShell
                 CONTROL view). Replaces Lovable's hardcoded ConnectPanel
                 so users can actually wire Composio, devices, auto-generate
                 and auto-dreaming. */
              <div className="h-full overflow-y-auto pt-12">
                <RealControlPanel composio={composio} />
              </div>
            ) : activeView === "account" ? (
              <AccountPanel
                userName={fullName || displayName}
                avatarLetter={avatarLetter}
                userEmail={user?.email ?? undefined}
                onSignOut={() => void signOut()}
                onDeleteAccount={async () => {
                  // Throws DeleteAccountError on fail-fast abort
                  // (Supabase Auth or DB cascade); panel surfaces the
                  // message. External partial failures (composio /
                  // litellm / stripe / browserbase / storage) come back
                  // as fields on the result, not exceptions — the
                  // cascade still succeeded so we proceed to sign out.
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
                    console.warn(
                      "Delete account: non-fatal external failures",
                      result,
                    );
                  }
                  // signOut clears local/session storage and reloads
                  // / — the actual app-state flush.
                  await signOut();
                }}
              />
            ) : null}
          </motion.div>
        </AnimatePresence>

        {/* ASK PIN AI — bottom-center entry into MainChat. Mirrors the
            minimalist constellation design (MinimalistNow): subtle pulse +
            ChevronUp + uppercase label. */}
        {activeView === "now" && (
          <button
            onClick={() => setMainChatOpen(true)}
            className="absolute bottom-6 left-1/2 -translate-x-1/2 z-30 flex flex-col items-center gap-1 px-3 py-1.5 group"
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

      {/* Live session fullscreen overlay — rendered at root via portal, fully independent of activeView.
          Wrapped in AnimatePresence so exit animation runs cleanly without affecting the underlying view. */}
      {createPortal(
        <AnimatePresence>
          {liveOverlay && (
            <LiveFullscreen
              key="live-fullscreen"
              session={liveSession ?? liveOverlay}
              onClose={() => setLiveOverlay(null)}
            />
          )}
        </AnimatePresence>,
        document.body
      )}

      {/* Main chat overlay. Opened by the bottom-center ASK PIN AI
          button. Separate from card chat: a standalone main thread per
          user. The portal escapes the Constellation tree (so z-index is
          unambiguous and the hamburger menu doesn't interfere) but the
          inner container forces the same `max-w-md` mobile column the
          rest of the app uses — without this, desktop viewers see the
          chat sprawled full-width, breaking the minimalist design. */}
      {createPortal(
        <AnimatePresence>
          {mainChatOpen && (
            <motion.div
              key="main-chat-overlay"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="fixed inset-0 z-50 flex justify-center bg-foreground/[0.04]"
            >
              <div className="relative w-full max-w-md h-screen overflow-hidden bg-background">
                <MainChat onBack={handleMainChatBack} />
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}

      {/* Hamburger side menu overlay */}
      <AnimatePresence>
        {menuOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-40 bg-foreground/10 backdrop-blur-sm"
              onClick={() => setMenuOpen(false)}
            />
            <motion.div
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ type: "spring", damping: 28, stiffness: 300 }}
              className="fixed top-0 right-0 bottom-0 z-50 w-56"
              style={{
                background: "linear-gradient(180deg, hsl(0 0% 100% / 0.85) 0%, hsl(0 0% 100% / 0.95) 100%)",
                backdropFilter: "blur(48px) saturate(1.5)",
                WebkitBackdropFilter: "blur(48px) saturate(1.5)",
                borderLeft: "1px solid hsl(0 0% 100% / 0.5)",
              }}
            >
              <div className="pt-14 px-5">
                <button onClick={() => setMenuOpen(false)} className="mb-8 p-1.5 rounded-full hover:bg-foreground/8">
                  <X size={20} strokeWidth={1.5} className="text-foreground/60" />
                </button>
                <div className="flex flex-col gap-1">
                  {MENU_ITEMS.map((item) => {
                    const Icon = item.icon;
                    const isActive = activeView === item.id && !activeChat;
                    return (
                      <button
                        key={item.id}
                        onClick={() => handleMenuNav(item.id)}
                        className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${
                          isActive ? "bg-foreground/8 text-foreground" : "text-foreground/50 hover:bg-foreground/4"
                        }`}
                      >
                        <Icon size={18} strokeWidth={isActive ? 2 : 1.5} />
                        <span className={`text-sm tracking-wider ${isActive ? "font-semibold" : "font-medium"}`}>
                          {item.label}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Card detail drawer */}
      <Drawer open={drawerOpen} onOpenChange={setDrawerOpen}>
        <DrawerContent
          className="max-h-[92vh] border-t-0 !bg-transparent"
          style={{
            background: "linear-gradient(180deg, hsla(0, 0%, 100%, 0.5) 0%, hsla(0, 0%, 100%, 0.7) 100%)",
            backdropFilter: "blur(40px) saturate(1.5)",
            WebkitBackdropFilter: "blur(40px) saturate(1.5)",
            border: "1px solid hsla(0, 0%, 100%, 0.4)",
            borderBottom: "none",
            borderRadius: "1.5rem 1.5rem 0 0",
          }}
          overlayClassName="!bg-foreground/5 backdrop-blur-[2px]"
        >
          <DrawerHeader className="sr-only">
            <DrawerTitle>{selectedCard?.title ?? "Card Detail"}</DrawerTitle>
            <DrawerDescription>Card detail view</DrawerDescription>
          </DrawerHeader>
          {selectedCard && (
            <CardDrawerContent
              card={selectedCard}
              completed={
                selectedCard.originalId
                  ? cardActions.doneIds.has(selectedCard.originalId) ||
                    isCompletedCardOutcome(
                      cardsState.cards.find(
                        (c) => c.card.id === selectedCard.originalId,
                      )?.latestOutcome,
                    )
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
                chatEntryView.current = activeView;
                // Real card → POST /feedback kind=card_action action=modify
                // and open MainChatView with empty bootstrap (lets user type).
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
                setActiveChat(chatCard);
                setActiveView("chat");
              }}
            />
          )}
        </DrawerContent>
      </Drawer>

      {/* Paywall dialog — locked tasks require Pro to approve */}
      <Drawer open={!!paywallCard} onOpenChange={(o) => !o && setPaywallCard(null)}>
        <DrawerContent
          className="max-h-[88vh] border-t-0 !bg-transparent"
          style={{
            background: "linear-gradient(180deg, hsla(0, 0%, 100%, 0.55) 0%, hsla(0, 0%, 100%, 0.78) 100%)",
            backdropFilter: "blur(40px) saturate(1.5)",
            WebkitBackdropFilter: "blur(40px) saturate(1.5)",
            border: "1px solid hsla(0, 0%, 100%, 0.4)",
            borderBottom: "none",
            borderRadius: "1.5rem 1.5rem 0 0",
          }}
          overlayClassName="!bg-foreground/10 backdrop-blur-[2px]"
        >
          <DrawerHeader className="sr-only">
            <DrawerTitle>Start free trial</DrawerTitle>
            <DrawerDescription>Choose a plan and payment method to approve this task</DrawerDescription>
          </DrawerHeader>
          <div className="flex flex-col" style={{ maxHeight: "84vh" }}>
            <div className="px-5 pt-3 pb-24 overflow-y-auto flex-1">
              <div className="text-center mb-3">
                <div className="mx-auto w-11 h-11 rounded-2xl flex items-center justify-center mb-3"
                  style={{ background: "linear-gradient(135deg, hsl(292,78%,63%) 0%, hsl(330,80%,65%) 100%)" }}>
                  <LockIcon size={18} strokeWidth={2.5} className="text-white" />
                </div>
                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-foreground/50 mb-1.5">
                  Subscription required
                </p>
                <h3 className="text-display text-[19px] leading-tight text-foreground font-semibold max-w-[20rem] mx-auto">
                  Pick a plan to approve “{paywallCard?.title}”
                </h3>
              </div>

              <PlanPaymentForm
                plan={paywallPlan} setPlan={setPaywallPlan}
                payMethod={paywallPay} setPayMethod={setPaywallPay}
                cardInfo={paywallCard_} setCardInfo={setPaywallCardInfo}
                showHero={false}
                allowSkip={false}
              />
            </div>

            <div
              className="flex items-center gap-2 px-5 py-3 border-t border-foreground/5"
              style={{ background: "hsl(var(--background))" }}
            >
              <button
                onClick={() => setPaywallCard(null)}
                className="px-4 py-3 rounded-xl bg-foreground/5 hover:bg-foreground/10 transition-colors text-[13px] font-medium text-foreground/55"
              >
                Not now
              </button>
              <button
                disabled={!isPayValid(paywallPay, paywallCard_)}
                onClick={() => {
                  const card = paywallCard;
                  setPaywallCard(null);
                  if (card) {
                    handleExecute({ ...card, locked: false });
                  }
                }}
                className="flex-1 flex items-center justify-center gap-1.5 px-4 py-3 rounded-xl text-background text-[13px] font-semibold transition-all hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ background: "linear-gradient(135deg, hsl(292,78%,63%) 0%, hsl(330,80%,65%) 100%)" }}
              >
                Subscribe · ${PLANS.find((p) => p.id === paywallPlan)?.price}/mo
              </button>
            </div>
          </div>
        </DrawerContent>
      </Drawer>

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
  );
}

/* ── Drawer card detail ──
 *
 * Subscribes to the same `useCardExecutionRun` hook the chat detail
 * view uses, keyed by the card's original string id (which the hook
 * maps to chat-stream session_key `card-thread-<id>`). That lets the
 * drawer pre-render plan / Generated draft / Approving will let agent
 * / Risks pulled from the latest propose_action's structured args,
 * cached via `lastMessagePayload`. Without this, DrawerDetailBody
 * falls back to `card.detail.executionPlan` (always empty for real
 * cards) and the drawer looks like a thin summary card.
 */
function CardDrawerContent({
  card,
  completed,
  onExecute,
  onClose,
  onModify,
  onDismiss,
}: {
  card: Intent;
  completed: boolean;
  onExecute: (card: Intent) => void;
  onClose: () => void;
  onModify: (card: Intent) => void;
  onDismiss: (card: Intent) => void;
}) {
  const cat = CATEGORIES[card.category];
  const Icon = cat.icon;
  // The hook accepts the card's original string id (gen.*_card_NN) and
  // internally maps it to session_key. We never set bootstrap here —
  // the drawer is read-only pre-review; firing a bootstrap turn from
  // a tap would surprise the user. The chat detail view fires it on
  // Approve when the thread is empty.
  const run = useCardExecutionRun(card.originalId ?? null);
  const showCompletedView = completed || run.snapshot?.status === "done";

  return (
    <div className="px-5 pb-5 pt-1.5 overflow-y-auto max-h-[88vh]">
      {/* Category */}
      <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
        <Icon size={14} strokeWidth={1.5} className="text-foreground/50" />
        <span className="text-xs font-semibold tracking-wide text-foreground/50 uppercase">{cat.label}</span>
        {card.tag && (
          <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-foreground/10 text-foreground/50">
            {card.tag}
          </span>
        )}
        {card.complexity === "simple" && (
          <span
            className="inline-flex items-center gap-1 text-[11px] font-bold px-1.5 py-0.5 rounded-full"
            style={{ background: "rgba(225,92,230,0.12)", color: "#E15CE6" }}
            title="Low-risk task — usually safe to approve as-is"
          >
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: "#E15CE6" }} />
            Quick approve
          </span>
        )}
      </div>

      {/* Title */}
      <h3 className="text-display text-[18px] leading-snug text-foreground mb-1.5 font-semibold">{card.title}</h3>

      {/* Concise "what to do" summary (gray, action-oriented) */}
      <p className="text-[13.5px] text-foreground/55 leading-snug mb-3">
        {card.detail?.willExecute || card.line1}
      </p>

      {/* Detail sections — DrawerDetailBody reads the latest
          propose_action's structured args from `lastMessagePayload`
          (plan / drafts / dangerous_actions / risks), falling back
          to the card's static detail when the agent hasn't paused
          yet. */}
      {card.detail && (
        <DrawerDetailBody
          card={card}
          runSnapshot={run.snapshot}
          lastMessagePayload={showCompletedView ? null : run.lastMessagePayload}
          sideEffects={run.snapshot?.result?.side_effects ?? []}
        />
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 mt-5">
        {showCompletedView ? (
          <button
            onClick={onClose}
            className="flex-1 flex items-center justify-center gap-1.5 px-4 py-3 rounded-xl bg-foreground/5 hover:bg-foreground/10 transition-colors text-[13px] font-medium text-foreground/55"
          >
            Close
          </button>
        ) : (
          <>
            <button
              onClick={() => onDismiss(card)}
              className="flex items-center justify-center gap-1.5 px-4 py-3 rounded-xl bg-foreground/5 hover:bg-foreground/10 transition-colors text-[13px] font-medium text-foreground/55"
            >
              <X size={13} strokeWidth={2} /> Dismiss
            </button>
            {!card.locked && (
              <button
                onClick={() => onModify(card)}
                className="flex items-center justify-center gap-1 px-3 py-3 rounded-xl bg-foreground/5 hover:bg-foreground/10 transition-colors text-[12px] font-medium text-foreground/55"
              >
                <Pencil size={11} strokeWidth={2} /> Steer
              </button>
            )}
            <button
              onClick={() => onExecute(card)}
              className="flex-1 flex items-center justify-center gap-1.5 px-4 py-3 rounded-xl bg-foreground text-background text-[13px] font-semibold hover:bg-foreground/85 transition-colors"
            >
              {card.locked ? (
                <><LockIcon size={13} strokeWidth={2.5} /> Approve</>
              ) : (
                <><Check size={13} strokeWidth={2.5} /> Approve</>
              )}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
