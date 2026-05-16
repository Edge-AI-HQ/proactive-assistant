import { useState, useEffect, useCallback, useRef, Suspense } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Menu, X, Zap, ListChecks, Settings, Pencil, Radio, User as UserIcon, Plug,
  Sprout, Briefcase, TrendingUp, Heart, BookOpen, Sparkles,
  ArrowRight, ChevronDown, Check, Cloud, Lock as LockIcon,
  MapPin, Sun, Activity, Users, ChevronRight, Target, MessageCircle,
  type LucideIcon,
} from "lucide-react";
import bgGradient from "@/assets/bg-gradient.jpg";
import AiSphere from "./AiSphere";
import Sphere3DCards from "./Sphere3DCards";
import ChatTimeline from "./ChatTimeline";

import ControlPanel from "./ControlPanel";
import AccountPanel from "./AccountPanel";
import ConnectPanel from "./ConnectPanel";
import AmbientView, { LiveFullscreen } from "./AmbientView";
import { createPortal } from "react-dom";
import ChatDetailView, { type ChatCard, brandSvg, detectToolIcon } from "./ChatDetailView";
import { DrawerDetailBody } from "./CardDrawerDetail";
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
import { useCards } from "@/hooks/useCards";
import { useComposio } from "@/hooks/useComposio";
import { usePipeline } from "@/hooks/usePipeline";
import { usePushNotifications } from "@/hooks/usePushNotifications";
import { useUserSettings } from "@/hooks/useUserSettings";
import { useWeather } from "@/hooks/useWeather";
import { PreNotificationPrompt } from "@/components/PreNotificationPrompt";
import { isNative } from "@/lib/platform";
import type { GoalBasket, IntentCard } from "@/types/intent-card";
import { useAmbientLiveSession } from "@/hooks/useAmbientLiveSession";
import { useUserSettings } from "@/hooks/useUserSettings";
import { getPersistedAmbientEnabled } from "@/services/ambient/enabled-state";
import LiveSessionCard from "./LiveSessionCard";
import type { LiveSession } from "@/services/ambient/live-session";

/** Pretty Member-since month from Supabase user.created_at (ISO). */
function formatMemberSince(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

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
function realCardToLovableIntent(card: IntentCard, status: CardStatus): Intent {
  return {
    id: djb2(card.id),
    originalId: card.id,
    category: basketToLovableCategory(card.goalBasket),
    tag: card.urgency >= 0.85 ? "Urgent" : undefined,
    title: card.title,
    line1: card.whyNow || card.summary,
    line2: card.sources.length > 0 ? `Sources: ${card.sources.join(" · ")}` : "",
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

const INTENTS: Omit<Intent, 'status' | 'statusTimestamp'>[] = [];
// Real cards are sourced from useCards() and synced into sphereCards via
// effect below; this mock array is intentionally empty.

/* ── Multiple slot layouts (left%, top offset from center%) ── */
const SLOT_LAYOUTS = [
  // Layout 0 — original organic scatter
  [
    { left: 3, y: -42 }, { left: 48, y: -34 }, { left: 20, y: -18 },
    { left: 55, y: -8 }, { left: 2, y: 6 }, { left: 40, y: 14 },
    { left: 15, y: 30 }, { left: 52, y: 36 }, { left: 5, y: 52 }, { left: 36, y: 56 },
  ],
  // Layout 1 — diagonal cascade
  [
    { left: 8, y: -40 }, { left: 52, y: -30 }, { left: 5, y: -14 },
    { left: 48, y: -4 }, { left: 12, y: 10 }, { left: 55, y: 20 },
    { left: 2, y: 32 }, { left: 44, y: 40 }, { left: 18, y: 50 }, { left: 50, y: 58 },
  ],
  // Layout 2 — clustered sides
  [
    { left: 2, y: -38 }, { left: 3, y: -20 }, { left: 50, y: -36 },
    { left: 52, y: -12 }, { left: 8, y: 4 }, { left: 48, y: 8 },
    { left: 4, y: 28 }, { left: 50, y: 30 }, { left: 20, y: 46 }, { left: 38, y: 54 },
  ],
  // Layout 3 — zigzag
  [
    { left: 45, y: -44 }, { left: 6, y: -30 }, { left: 50, y: -16 },
    { left: 3, y: -2 }, { left: 46, y: 12 }, { left: 8, y: 22 },
    { left: 48, y: 34 }, { left: 5, y: 42 }, { left: 42, y: 52 }, { left: 15, y: 58 },
  ],
  // Layout 4 — centered vertical spread
  [
    { left: 18, y: -44 }, { left: 42, y: -38 }, { left: 8, y: -20 },
    { left: 52, y: -14 }, { left: 25, y: 0 }, { left: 48, y: 10 },
    { left: 4, y: 24 }, { left: 38, y: 32 }, { left: 12, y: 48 }, { left: 50, y: 54 },
  ],
];

// Helper to get slot positions for a layout index
const getSlotPositions = (layoutIdx: number) => SLOT_LAYOUTS[layoutIdx % SLOT_LAYOUTS.length];

/* Initial processing card IDs */
const INITIAL_PROCESSING_IDS = new Set([2, 3, 7]);

const AI_GREETINGS = [
  "Your 2pm meeting has been moved to 4pm",
  "A follow-up draft has been prepared for Alex",
  "Two threads are waiting for your input",
];

/* ── Hamburger side menu items ── */
const MENU_ITEMS = [
  { id: "now", label: "NOW", icon: Zap },
  { id: "ambient", label: "AMBIENT", icon: Radio },
  { id: "chat", label: "TASKS", icon: ListChecks },
  { id: "profile", label: "PROFILE", icon: Target },
  { id: "connect", label: "CONNECT", icon: Plug },
  { id: "control", label: "CONTROL", icon: Settings },
  { id: "account", label: "ACCOUNT", icon: UserIcon },
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
  const { settings } = useUserSettings();
  const consentOn = settings
    ? Object.values(settings.ambientSources ?? {}).some((c) => c?.enabled === true)
    : null;
  const ambientOn = getPersistedAmbientEnabled() || (consentOn ?? false);
  const { session: liveSession, previewVisibleCount } = useAmbientLiveSession({
    ambientOn: activeView === "ambient" ? false : ambientOn,
    enableWebDemo: false,
    dismissible: false,
  });
  const [isScrolled, setIsScrolled] = useState(false);
  const [mainChatOpen, setMainChatOpen] = useState(false);

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
  const memberSince = formatMemberSince(user?.created_at);

  // ── Real-backend integration (preserved card execution path) ──
  const cardsState = useCards();
  const composio = useComposio();
  const pipeline = usePipeline();
  // Notification permission flow. iOS OS state is the source of truth;
  // notifyNewCards is a backend mirror that the send pipeline reads. The
  // two effects below keep these in sync:
  //
  //   * Sheet only opens when state is "prompt" — granted / denied skip
  //     it entirely (the second effect auto-stamps prompted_at so the
  //     skip doesn't keep firing on every cold start).
  //   * notifyNewCards <- (state === "granted") on every transition so
  //     a user who toggles in iOS Settings sees the backend reconciled
  //     on the next foreground (usePushNotifications listens to
  //     appStateChange and re-checks).
  const userSettings = useUserSettings();
  const pushNotifications = usePushNotifications();
  const osGranted = pushNotifications.permissionState === "granted";
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
  // Mirror OS state into the backend `notify_new_cards` flag so the
  // send pipeline sees the up-to-date preference. Triggers on resume
  // (state re-check fires) and on initial mount once ready.
  useEffect(() => {
    if (!isNative || !pushNotifications.ready) return;
    if (!userSettings.settings) return;
    if (userSettings.settings.notifyNewCards === osGranted) return;
    void userSettings.patch({ notifyNewCards: osGranted });
  }, [
    pushNotifications.ready, osGranted,
    userSettings.settings, userSettings.patch,
  ]);
  /** When set, ConstellationLayout renders our existing CardChat overlay
   *  (MainChatView + SSE chat-stream runtime). Replaces Lovable's mock
   *  ChatDetailView path. */
  const [chatTarget, setChatTarget] = useState<{
    card: IntentCard;
    bootstrap?: string;
  } | null>(null);
  const cardActions = useCardActions({
    onOpenChat: (card, bootstrap) => {
      const trimmed = bootstrap.trim();
      setChatTarget({ card, bootstrap: trimmed.length > 0 ? trimmed : undefined });
      setDrawerOpen(false);
      setSelectedCard(null);
    },
  });

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

  // Layout rotation state
  const [currentLayoutIdx, setCurrentLayoutIdx] = useState(0);
  const [scatterKey, setScatterKey] = useState(0); // bump to trigger scatter-out
  const [globalExitDirection, setGlobalExitDirection] = useState<"left" | "scatter">("scatter");
  const touchStartY = useRef<number | null>(null);
  const touchStartX = useRef<number | null>(null);
  const isScattering = useRef(false);

  // Each card carries its assigned slot index
  type SlottedIntent = Intent & { slotIndex: number; exitDirection?: "left" | "scatter" };
  const [visibleCards, setVisibleCards] = useState<SlottedIntent[]>(() =>
    INTENTS.slice(0, 6).map((c, i) => ({
      ...c,
      status: "normal" as CardStatus,
      statusTimestamp: Date.now(),
      slotIndex: i,
    }))
  );
  const nextIdRef = useRef(100);

  // Sphere cards (for /big-ball-design-2 "now" 3D sphere) — separate state
  // so the sphere can show a growing/shrinking set of cards with new/processing/done
  // lifecycle, independent of the legacy floating-cards system.
  const [sphereCards, setSphereCards] = useState<Intent[]>([]);

  // Mirror real /api/cards into sphereCards (one-way sync). Replaces the
  // Lovable mock initial seed + the legacy add-new ticker. Status reflects
  // useCardActions' optimistic processing/done state.
  useEffect(() => {
    const next: Intent[] = cardsState.cards
      .filter(
        (c) =>
          !cardActions.dismissedIds.has(c.card.id) &&
          !cardActions.doneIds.has(c.card.id),
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

  // Dismiss a single card (swipe left) — mark direction then remove after a tick
  const dismissCard = useCallback((id: number) => {
    setVisibleCards((prev) =>
      prev.map((c) => c.id === id ? { ...c, exitDirection: "left" as const } : c)
    );
    // Remove after a frame so AnimatePresence picks up the exitDirection
    requestAnimationFrame(() => {
      setVisibleCards((prev) => prev.filter((c) => c.id !== id));
    });
  }, []);

  // Helper: find first free slot using current layout
  const findFreeSlot = (cards: SlottedIntent[], layoutIdx?: number): number | null => {
    const positions = getSlotPositions(layoutIdx ?? currentLayoutIdx);
    const usedSlots = new Set(cards.map((c) => c.slotIndex));
    for (let i = 0; i < positions.length; i++) {
      if (!usedSlots.has(i)) return i;
    }
    return null;
  };

  // Swipe handler: scatter or fly-left cards and reload with new layout
  const handleSwipeRefresh = useCallback((direction: "left" | "scatter" = "scatter") => {
    if (isScattering.current) return;
    isScattering.current = true;
    // Set global exit direction so all cards use the right exit animation
    setGlobalExitDirection(direction);
    // Clear all cards to trigger exit animations
    setScatterKey((k) => k + 1);
    setVisibleCards([]);

    // After animation, load new batch with new layout
    setTimeout(() => {
      setGlobalExitDirection("scatter"); // reset for next time
      setCurrentLayoutIdx((prev) => {
        const candidates = Array.from({ length: SLOT_LAYOUTS.length }, (_, i) => i).filter(i => i !== prev);
        return candidates[Math.floor(Math.random() * candidates.length)];
      });

      const shuffled = [...INTENTS].sort(() => Math.random() - 0.5);
      const batch = shuffled.slice(0, 6);
      setCurrentLayoutIdx((newIdx) => {
        const newCards: SlottedIntent[] = batch.map((c, i) => ({
          ...c,
          status: "normal" as CardStatus,
          statusTimestamp: Date.now(),
          slotIndex: i,
        }));
        setVisibleCards(newCards);
        return newIdx;
      });

      isScattering.current = false;
    }, 600);
  }, []);

  // Touch handlers for swipe detection (up, down, left)
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartY.current = e.touches[0].clientY;
    touchStartX.current = e.touches[0].clientX;
  }, []);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (touchStartY.current === null || touchStartX.current === null) return;
    const deltaY = touchStartY.current - e.changedTouches[0].clientY;
    const deltaX = touchStartX.current - e.changedTouches[0].clientX;
    touchStartY.current = null;
    touchStartX.current = null;
    if (activeView !== "now") return;
    // Left swipe: cards fly left
    if (deltaX > 80 && Math.abs(deltaX) > Math.abs(deltaY)) {
      handleSwipeRefresh("left");
    } else if (Math.abs(deltaY) > 80) {
      // Up or down swipe: scatter outward
      handleSwipeRefresh("scatter");
    }
  }, [activeView, handleSwipeRefresh]);

  // Status transitions: new→normal (10s), processing→done (10s), done→remove (10s)
  useEffect(() => {
    const ticker = setInterval(() => {
      const now = Date.now();
      setVisibleCards((prev) => {
        let changed = false;
        const next = prev.reduce<SlottedIntent[]>((acc, card) => {
          const elapsed = now - (card.statusTimestamp || 0);
          if (card.status === "new" && elapsed >= 10000) {
            changed = true;
            acc.push({ ...card, status: "normal", statusTimestamp: now });
          } else if (card.status === "processing" && elapsed >= 10000) {
            changed = true;
            acc.push({ ...card, status: "done", statusTimestamp: now });
          } else if (card.status === "done" && elapsed >= 10000) {
            changed = true;
            // card removed — slot freed
          } else {
            acc.push(card);
          }
          return acc;
        }, []);
        return changed ? next : prev;
      });
    }, 1000);
    return () => clearInterval(ticker);
  }, []);

  // Add new cards periodically
  useEffect(() => {
    const addInterval = setInterval(() => {
      setVisibleCards((prev) => {
        if (prev.length >= 8) return prev;
        const freeSlot = findFreeSlot(prev);
        if (freeSlot === null) return prev; // no free slot
        const shown = new Set(prev.map((c) => c.id));
        const pool = INTENTS.filter((c) => !shown.has(c.id));
        if (pool.length === 0) return prev; // no new cards to add
        const base = pool[Math.floor(Math.random() * pool.length)];
        const newCard: SlottedIntent = {
          ...base,
          status: "new",
          statusTimestamp: Date.now(),
          slotIndex: freeSlot,
        };
        return [...prev, newCard];
      });
    }, 7000 + Math.random() * 4000);
    return () => clearInterval(addInterval);
  }, []);

  // Chat state
  const [cardChats, setCardChats] = useState<ChatCard[]>([]);
  const [activeChat, setActiveChat] = useState<ChatCard | null>(null);
  const [chatMode, setChatMode] = useState<"confirm" | "modify" | "done" | "steer">("confirm");
  const chatEntryView = useRef<MenuId | null>(null);
  

  // Greeting rotation
  const [greetIdx, setGreetIdx] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setGreetIdx((p) => (p + 1) % AI_GREETINGS.length), 5000);
    return () => clearInterval(t);
  }, []);

  // Sphere lifecycle: new→normal (10s), processing→done (10s), done→remove (10s)
  useEffect(() => {
    const ticker = setInterval(() => {
      const now = Date.now();
      setSphereCards((prev) => {
        let changed = false;
        const next = prev.reduce<Intent[]>((acc, card) => {
          const elapsed = now - (card.statusTimestamp || 0);
          if (card.status === "new" && elapsed >= 10000) {
            changed = true;
            acc.push({ ...card, status: "normal", statusTimestamp: now });
          } else if (card.status === "processing" && elapsed >= 10000) {
            changed = true;
            acc.push({ ...card, status: "done", statusTimestamp: now });
          } else if (card.status === "done" && elapsed >= 10000) {
            changed = true;
            // removed
          } else {
            acc.push(card);
          }
          return acc;
        }, []);
        return changed ? next : prev;
      });
    }, 1000);
    return () => clearInterval(ticker);
  }, []);

  // Periodically introduce a new "new" card on the sphere
  useEffect(() => {
    const addInterval = setInterval(() => {
      setSphereCards((prev) => {
        if (prev.length >= 14) return prev;
        const shown = new Set(prev.map((c) => c.id));
        const pool = INTENTS.filter((c) => !shown.has(c.id));
        if (pool.length === 0) return prev;
        const base = pool[Math.floor(Math.random() * pool.length)];
        const newCard: Intent = {
          ...base,
          status: "new",
          statusTimestamp: Date.now(),
        };
        return [...prev, newCard];
      });
    }, 7000 + Math.random() * 4000);
    return () => clearInterval(addInterval);
  }, []);

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
    // Legacy mock path (INTENTS is empty now; kept for type completeness).
    setDrawerOpen(false);
    setSelectedCard(null);
    setVisibleCards((prev) =>
      prev.map((c) =>
        c.id === card.id ? { ...c, status: "processing" as CardStatus, statusTimestamp: Date.now() } : c
      )
    );
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

  const handleMenuNav = (id: MenuId) => {
    setActiveView(id);
    setActiveChat(null);
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

        {/* Ambient — passive, always present. Single subtle line. */}
        <button
          onClick={() => setActiveView("ambient")}
          className="w-full flex items-center gap-3 py-2.5 text-left group"
          aria-label="Open Ambient"
        >
          <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-foreground/40 shrink-0 w-[60px]">
            Ambient
          </span>
          <span className="text-[13px] text-foreground/75 truncate flex-1 leading-snug">
            {weather
              ? `${weather.city} · ${weather.label} · ${weather.temp}°`
              : "Quiet ambient — connect sources to start streaming signals"}
          </span>
          <ChevronRight size={14} className="text-foreground/25 group-hover:text-foreground/55 shrink-0 transition-colors" />
        </button>

        {/* Live session — always present; real transcript replaces standby when available. */}
        <div className="h-px bg-foreground/[0.08] mb-3" />
        <LiveSessionCard
          session={liveSession}
          previewVisibleCount={previewVisibleCount}
          variant="now"
          alwaysVisible
          onFocus={setLiveOverlay}
        />
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
              const chatCard = card as ChatCard;
              setCardChats((prev) => prev.find((c) => c.id === chatCard.id) ? prev : [chatCard, ...prev]);
              chatEntryView.current = activeView;
              // Processing cards opened from sphere → ask 1–3 input questions first.
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
          <button
            onClick={() => setMainChatOpen(true)}
            className="px-3 py-1.5 rounded-full glass-card-strong text-xs font-medium text-foreground/70 inline-flex items-center gap-1.5"
            title="Open main chat"
          >
            <MessageCircle size={14} strokeWidth={1.5} />
            Chat
          </button>
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
              /* Real card execution: existing CardChat → MainChatView path
                 (SSE chat-stream, real agent runtime). */
              <CardChat
                card={chatTarget.card}
                bootstrapMessage={chatTarget.bootstrap}
                onBack={() => {
                  const returnTo = chatEntryView.current;
                  setChatTarget(null);
                  if (returnTo) setActiveView(returnTo);
                }}
              />
            ) : activeChat ? (
              /* Legacy mock-card path (Lovable's INTENTS). Unused now that
                 the mock array is empty, but kept so type-checking stays
                 honest if mock data is reintroduced for demos. */
              <CardChat
                card={lovableIntentToIntentCard(activeChat)}
                bootstrapMessage={activeChat.detail?.willExecute || activeChat.title}
                onBack={() => {
                  const returnTo = chatEntryView.current;
                  setActiveChat(null);
                  if (returnTo) setActiveView(returnTo);
                }}
              />
            ) : activeView === "now" ? (
              renderNowView()
            ) : activeView === "chat" ? (
              /* Real card history (old AppShell CHAT view). Reads from
                 /api/cards via useCards(); confirm/dismiss/done buttons
                 POST to /feedback via the timeline itself. */
              <div className="h-full overflow-y-auto pt-12">
                <RealChatTimeline
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
                  onConfirmId={cardActions.markConfirmed}
                  onDismissId={cardActions.markDismissed}
                  onDoneId={cardActions.markDone}
                  onProcessingId={cardActions.markProcessing}
                  onChattedId={cardActions.markChatted}
                />
              </div>
            ) : activeView === "ambient" ? (
              <AmbientView onConnectMore={() => setActiveView("connect")} onOpenFullscreen={(s) => setLiveOverlay(s)} />
            ) : activeView === "profile" ? (
              /* Real goals/memory/skill page (old AppShell GOALS view). */
              <div className="h-full overflow-y-auto pt-12">
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
            ) : activeView === "control" ? (
              <ControlPanel />
            ) : activeView === "account" ? (
              <AccountPanel
                userName={fullName || displayName}
                avatarLetter={avatarLetter}
                userEmail={user?.email ?? undefined}
                memberSince={memberSince}
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
      </div>

      {/* Live session fullscreen overlay — rendered at root via portal, fully independent of activeView.
          Wrapped in AnimatePresence so exit animation runs cleanly without affecting the underlying view. */}
      {createPortal(
        <AnimatePresence>
          {liveOverlay && (
            <LiveFullscreen
              key="live-fullscreen"
              session={liveOverlay}
              onClose={() => setLiveOverlay(null)}
            />
          )}
        </AnimatePresence>,
        document.body
      )}

      {/* Main chat overlay (full-screen). Opened by the top-right "Chat"
          button. Separate from card chat: this is a standalone main
          thread keyed by user.id, restored from sessionStorage. Mirrors
          the AppShell-era mainChatOpen behavior. */}
      {createPortal(
        <AnimatePresence>
          {mainChatOpen && (
            <motion.div
              key="main-chat-overlay"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="fixed inset-0 z-50 bg-background"
            >
              <MainChat onBack={() => setMainChatOpen(false)} />
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
                dismissCard(card.id);
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
          // The auto-sync effect above handles notifyNewCards once
          // permissionState updates — we only stamp prompted_at here so
          // the sheet doesn't re-show.
          await pushNotifications.requestPermission();
          await userSettings.patch({ notifyPermissionPrompted: true });
        }}
        onDecline={async () => {
          await userSettings.patch({ notifyPermissionPrompted: true });
        }}
      />
    </div>
  );
}

/* ── Drawer card detail ── */
function CardDrawerContent({
  card,
  onExecute,
  onClose,
  onModify,
  onDismiss,
}: {
  card: Intent;
  onExecute: (card: Intent) => void;
  onClose: () => void;
  onModify: (card: Intent) => void;
  onDismiss: (card: Intent) => void;
}) {
  const cat = CATEGORIES[card.category];
  const Icon = cat.icon;

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

      {/* Detail sections */}
      {card.detail && (
        <>
          <DrawerDetailBody card={card} />
        </>
      )}

      {/* Actions — Dismiss / Steer / Approve */}
      <div className="flex items-center gap-2 mt-5">
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
      </div>
    </div>
  );
}


