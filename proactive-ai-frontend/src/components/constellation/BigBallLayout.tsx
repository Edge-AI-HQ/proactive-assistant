import { useState, useEffect, useCallback, useRef, Suspense } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Menu, X, Zap, MessageCircle, Target, Settings, Pencil,
  Sprout, Briefcase, TrendingUp, Heart, BookOpen, Sparkles,
  ArrowRight, ChevronDown, Check,
  type LucideIcon,
} from "lucide-react";
import bgGradient from "@/assets/bg-gradient.jpg";
import AiSphere from "./AiSphere";
import ChatTimeline from "./ChatTimeline";
import GoalsView from "./GoalsView";
import ControlPanel from "./ControlPanel";
import ChatDetailView, { type ChatCard } from "./ChatDetailView";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";

/* ── Card data (reused from NowFeed) ── */

interface ExecutionStep { text: string; tool: string; }
interface DetailData {
  scores: { label: string; value: number }[];
  willExecute: string;
  executionPlan: ExecutionStep[];
  dataSources: string[];
  impact: string;
  permissions: string;
}
type CardStatus = "normal" | "new" | "processing" | "done";
interface Intent {
  id: number;
  category: string;
  tag?: string;
  title: string;
  line1: string;
  line2: string;
  detail?: DetailData;
  status: CardStatus;
  statusTimestamp?: number; // when status was set
}

const CATEGORIES: Record<string, { icon: LucideIcon; label: string }> = {
  growth:  { icon: Sprout,      label: "Growth" },
  work:    { icon: Briefcase,   label: "Work" },
  finance: { icon: TrendingUp,  label: "Finance" },
  health:  { icon: Heart,       label: "Health" },
  learn:   { icon: BookOpen,    label: "Learn" },
  life:    { icon: Sparkles,    label: "Life" },
};

const INTENTS: Omit<Intent, 'status' | 'statusTimestamp'>[] = [
  {
    id: 7, category: "work", tag: "Urgent",
    title: "Outstanding Invoice from Alex",
    line1: "Alex Chen from Acme Consulting sent a follow-up asking to settle the outstanding March invoice.",
    line2: "Sources: Gmail · Google Calendar",
    detail: {
      scores: [
        { label: "Confidence", value: 92 }, { label: "Importance", value: 85 },
        { label: "Urgency", value: 92 }, { label: "Risk", value: 10 },
      ],
      willExecute: "Draft payment confirmation to Alex, coordinate with Sarah for March advisory invoice payment, notify finance channel",
      executionPlan: [
        { text: "Reply to Alex confirming payment timeline", tool: "gmail create draft" },
        { text: "Ask Sarah to initiate payment for March advisory invoice", tool: "gmail create draft" },
        { text: "Notify finance channel about pending invoice", tool: "slack send message" },
      ],
      dataSources: [
        "Gmail — Alex Chen: Outstanding March advisory invoice",
        "Calendar context — Finance team availability",
      ],
      impact: "Maintains vendor relationships and ensures timely invoice processing.",
      permissions: "Gmail, Slack, GCal · All operations are reversible.",
    },
  },
  {
    id: 1, category: "growth", tag: "Cross Signal",
    title: "Anthropic's \"Mythos\" model leaked",
    line1: "Multiple sources report a leaked model showing dramatic capability gains.",
    line2: "Sources: Web Search · Notion",
    detail: {
      scores: [
        { label: "Confidence", value: 68 }, { label: "Importance", value: 88 },
        { label: "Urgency", value: 60 }, { label: "Risk", value: 5 },
      ],
      willExecute: "Compile leaked details, assess competitive implications for DemoAI, share analysis with team",
      executionPlan: [
        { text: "Search for Anthropic Mythos model leak details", tool: "web search" },
        { text: "Cross-reference with existing Notion AI landscape notes", tool: "notion search" },
        { text: "Share competitive analysis summary in #strategy channel", tool: "slack send message" },
      ],
      dataSources: [
        "Web — Multiple reports on Anthropic Mythos model leak",
        "Notion — AI competitive landscape tracker",
      ],
      impact: "Major competitive signal — potential shift in model capabilities landscape affecting DemoAI strategy.",
      permissions: "Web, Notion, Slack · Pure information gathering.",
    },
  },
  {
    id: 2, category: "work",
    title: "Meet Rai TODAY at 2pm",
    line1: "Calendar event confirmed with location pin.",
    line2: "Sources: gcal · gmail · notion",
    detail: {
      scores: [
        { label: "Confidence", value: 95 }, { label: "Importance", value: 80 },
        { label: "Urgency", value: 90 }, { label: "Risk", value: 5 },
      ],
      willExecute: "Prepare meeting brief, pull relevant notes from Notion, set travel reminder",
      executionPlan: [
        { text: "Pull last conversation context with Rai from Gmail", tool: "gmail search" },
        { text: "Compile meeting prep notes from Notion", tool: "notion search" },
        { text: "Set 30-min travel reminder", tool: "gcal update event" },
      ],
      dataSources: [
        "Google Calendar — Meeting with Rai, 2:00 PM today",
        "Gmail — Last email thread with Rai (3 days ago)",
        "Notion — Rai partnership notes",
      ],
      impact: "Ensures you're prepared and on time for an important in-person meeting.",
      permissions: "GCal, Gmail, Notion · All operations are reversible.",
    },
  },
  {
    id: 3, category: "finance",
    title: "Brex charged $34,778 to TriNet",
    line1: "Recurring payroll charge detected, matches last month.",
    line2: "Sources: gmail · brex",
    detail: {
      scores: [
        { label: "Confidence", value: 96 }, { label: "Importance", value: 70 },
        { label: "Urgency", value: 50 }, { label: "Risk", value: 8 },
      ],
      willExecute: "Verify charge matches expected payroll amount, flag any discrepancies, log in finance tracker",
      executionPlan: [
        { text: "Compare with last month's TriNet charge", tool: "gmail search" },
        { text: "Verify headcount hasn't changed unexpectedly", tool: "notion search" },
        { text: "Log payroll confirmation in #finance channel", tool: "slack send message" },
      ],
      dataSources: [
        "Gmail — Brex transaction alert: $34,778 to TriNet",
        "Brex — Transaction history, recurring payroll",
      ],
      impact: "Confirms payroll processed correctly. Flags anomalies early if headcount or amounts shift.",
      permissions: "Gmail, Notion, Slack · Read-only verification.",
    },
  },
  {
    id: 4, category: "finance", tag: "Alert",
    title: "Jaycie needs cap table shares",
    line1: "Urgent request from legal, pending your approval.",
    line2: "Sources: gmail",
    detail: {
      scores: [
        { label: "Confidence", value: 88 }, { label: "Importance", value: 90 },
        { label: "Urgency", value: 85 }, { label: "Risk", value: 15 },
      ],
      willExecute: "Review cap table request details, verify with legal team, prepare approval or follow-up questions",
      executionPlan: [
        { text: "Pull Jaycie's equity grant details from Gmail thread", tool: "gmail search" },
        { text: "Cross-reference with current cap table in Notion", tool: "notion search" },
        { text: "Draft approval reply or request clarification from legal", tool: "gmail create draft" },
      ],
      dataSources: [
        "Gmail — Jaycie cap table shares request from legal",
        "Notion — Cap table and equity allocation records",
      ],
      impact: "Time-sensitive legal/equity action. Delayed response could block Jaycie's onboarding or vesting.",
      permissions: "Gmail, Notion · Draft only, requires your send confirmation.",
    },
  },
  {
    id: 5, category: "work",
    title: "Team Meeting Monday 4:30 PM",
    line1: "Agenda includes product roadmap and hiring updates.",
    line2: "Sources: gcal · notion · slack",
    detail: {
      scores: [
        { label: "Confidence", value: 90 }, { label: "Importance", value: 75 },
        { label: "Urgency", value: 65 }, { label: "Risk", value: 5 },
      ],
      willExecute: "Pull agenda from Notion, gather recent Slack updates, prepare talking points",
      executionPlan: [
        { text: "Fetch meeting agenda from Notion", tool: "notion search" },
        { text: "Summarize key Slack threads from this week", tool: "slack search" },
        { text: "Add talking points to calendar event notes", tool: "gcal update event" },
      ],
      dataSources: [
        "Google Calendar — Team Meeting, Monday 4:30 PM",
        "Notion — Weekly meeting agenda template",
        "Slack — #product and #hiring channels, past 7 days",
      ],
      impact: "Arrive prepared with context. Saves 15-20 minutes of pre-meeting scrambling.",
      permissions: "GCal, Notion, Slack · All operations are reversible.",
    },
  },
  {
    id: 6, category: "health",
    title: "Weekly health check — biomarkers",
    line1: "HRV trending down 8% this week, sleep score stable.",
    line2: "Sources: whoop · apple health",
    detail: {
      scores: [
        { label: "Confidence", value: 85 }, { label: "Importance", value: 65 },
        { label: "Urgency", value: 40 }, { label: "Risk", value: 10 },
      ],
      willExecute: "Analyze weekly trends, compare with activity log, suggest recovery adjustments",
      executionPlan: [
        { text: "Pull 7-day HRV and sleep trend from Whoop", tool: "whoop api" },
        { text: "Cross-reference with this week's workout intensity", tool: "apple health sync" },
        { text: "Generate weekly health summary with recommendations", tool: "notion create page" },
      ],
      dataSources: [
        "Whoop — HRV down 8%, recovery score 62%, strain avg 14.2",
        "Apple Health — Sleep 7.1h avg, resting HR stable at 52bpm",
      ],
      impact: "Early warning on recovery trend. Suggests lighter training or earlier bedtime this weekend.",
      permissions: "Whoop, Apple Health, Notion · Read and create only.",
    },
  },
  {
    id: 8, category: "life", tag: "Personal Signal",
    title: "Downtown Mall Appointment Today",
    line1: "You have a tentative appointment at Downtown Mall Store at 11:30 AM today. Currently marked as tentative — confirm or decline.",
    line2: "Sources: Google Calendar",
    detail: {
      scores: [
        { label: "Confidence", value: 80 }, { label: "Importance", value: 60 },
        { label: "Urgency", value: 80 }, { label: "Risk", value: 5 },
      ],
      willExecute: "Confirm or decline appointment, check directions, adjust calendar",
      executionPlan: [
        { text: "Confirm or decline Downtown Mall appointment", tool: "gcal update event" },
        { text: "Check directions to Downtown Mall", tool: "web search" },
      ],
      dataSources: [
        "Calendar — Downtown Mall Store, 11:30 AM today (tentative)",
      ],
      impact: "Clarifies schedule availability for today.",
      permissions: "GCal, Web · Reversible.",
    },
  },
  {
    id: 9, category: "work", tag: "World Signal",
    title: "OpenRouter Hits $1.3B — Multi-Model AI Signal",
    line1: "The Information reports OpenRouter, which helps AI apps choose the right models, is nearing a $1.3B valuation. As DemoAI builds personal AI with multi-model capabilities, this validates the multi-model routing approach.",
    line2: "Sources: Gmail · Web Search · Slack",
    detail: {
      scores: [
        { label: "Confidence", value: 78 }, { label: "Importance", value: 75 },
        { label: "Urgency", value: 78 }, { label: "Risk", value: 10 },
      ],
      willExecute: "Read full article, share with team in Slack, discuss implications for DemoAI",
      executionPlan: [
        { text: "Search for OpenRouter $1.3B valuation news", tool: "web search" },
        { text: "Share OpenRouter news with team", tool: "slack send message" },
      ],
      dataSources: [
        "Gmail — The Information: OpenRouter $1.3B valuation",
        "Web — OpenRouter multi-model routing platform",
      ],
      impact: "Market validation of multi-model routing approach. Strategic signal for DemoAI positioning.",
      permissions: "Web, Gmail, Slack · Pure information.",
    },
  },
  {
    id: 10, category: "work", tag: "Personal Signal",
    title: "Team Wants Claude Team Plan Access",
    line1: "Team Member A asked Team Lead in Slack #dev to be added to the Claude team plan. Meanwhile, the team is evaluating DataConnector.dev for connecting apps — Team Member B shared a comprehensive personal assistant info source spreadsheet.",
    line2: "Sources: Slack",
    detail: {
      scores: [
        { label: "Confidence", value: 70 }, { label: "Importance", value: 65 },
        { label: "Urgency", value: 70 }, { label: "Risk", value: 5 },
      ],
      willExecute: "Check team plan seats, approve Team Member A, review DataConnector.dev spreadsheet",
      executionPlan: [
        { text: "Check Claude team plan seats with Team Lead", tool: "slack send message" },
        { text: "Research DataConnector.dev capabilities", tool: "web search" },
      ],
      dataSources: [
        "Slack #dev — Team Member A requesting Claude team plan access",
        "Slack #dev — Team Member B sharing DataConnector.dev evaluation spreadsheet",
      ],
      impact: "Unblocks team access to Claude APIs. Advances app connector evaluation.",
      permissions: "Slack, Web · Reversible.",
    },
  },
  {
    id: 11, category: "work", tag: "Urgent",
    title: "Midweek Update Due in 2 Hours",
    line1: "The [Reminder] DemoAI Team Midweek Update meeting is at 5:00 PM today (19 attendees). You need to update action item status on the Team Meetings Notion page and post an update in the DemoAI Core Slack channel.",
    line2: "Sources: Google Calendar · Notion · Slack",
    detail: {
      scores: [
        { label: "Confidence", value: 95 }, { label: "Importance", value: 90 },
        { label: "Urgency", value: 95 }, { label: "Risk", value: 5 },
      ],
      willExecute: "Open Notion Team Meetings page, update action items, post update in DemoAI Core channel",
      executionPlan: [
        { text: "Update Team Meetings action items", tool: "notion update page" },
        { text: "Post midweek update in DemoAI Core channel", tool: "slack send message" },
      ],
      dataSources: [
        "Calendar — DemoAI Team Midweek Update 5:00 PM today (19 attendees)",
        "Notion — Team Meetings action items page",
      ],
      impact: "Ensures team alignment heading into second half of week.",
      permissions: "Notion, Slack, GCal · All operations are reversible.",
    },
  },
  {
    id: 12, category: "finance", tag: "World Signal",
    title: "Bitcoin Quantum Threat Escalating",
    line1: "Cryptopolitan reports the quantum computing threat to Bitcoin has moved closer. As DemoAI has crypto/Web3 positioning, this is relevant to your token strategy and investor communications.",
    line2: "Sources: Gmail · Web Search",
    detail: {
      scores: [
        { label: "Confidence", value: 72 }, { label: "Importance", value: 70 },
        { label: "Urgency", value: 72 }, { label: "Risk", value: 25 },
      ],
      willExecute: "Read analysis, discuss with Co-Founder on implications, review Demo token security",
      executionPlan: [
        { text: "Search quantum computing threat to Bitcoin", tool: "web search" },
        { text: "Draft discussion note for Co-Founder", tool: "gmail create draft" },
      ],
      dataSources: [
        "Gmail — Cryptopolitan: Bitcoin quantum computing threat timeline",
        "Web — Quantum computing threat to cryptocurrency",
      ],
      impact: "Potential security and strategic implications for DemoAI's Web3/crypto positioning.",
      permissions: "Web, Gmail · Pure information.",
    },
  },
];

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
  { id: "chat", label: "CHAT", icon: MessageCircle },
  { id: "goals", label: "GOALS", icon: Target },
  { id: "control", label: "CONTROL", icon: Settings },
] as const;
type MenuId = (typeof MENU_ITEMS)[number]["id"];

/* ── Main component ── */
export default function BigBallLayout() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeView, setActiveView] = useState<MenuId>("now");
  const [selectedCard, setSelectedCard] = useState<Intent | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

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
  const [chatMode, setChatMode] = useState<"confirm" | "modify" | "done">("confirm");
  const chatEntryView = useRef<"now" | "chat" | "goals" | "control" | null>(null);

  // Greeting rotation
  const [greetIdx, setGreetIdx] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setGreetIdx((p) => (p + 1) % AI_GREETINGS.length), 5000);
    return () => clearInterval(t);
  }, []);

  const handleCardTap = (card: Intent) => {
    setSelectedCard(card);
    setDrawerOpen(true);
  };

  const handleExecute = useCallback((card: Intent) => {
    setDrawerOpen(false);
    setSelectedCard(null);
    // Set the card to processing status on the floating card
    setVisibleCards((prev) =>
      prev.map((c) =>
        c.id === card.id ? { ...c, status: "processing" as CardStatus, statusTimestamp: Date.now() } : c
      )
    );
    const chatCard = card as ChatCard;
    setCardChats((prev) => {
      if (prev.find((c) => c.id === chatCard.id)) return prev;
      return [chatCard, ...prev];
    });
    chatEntryView.current = activeView;
    setChatMode("confirm");
    setActiveChat(chatCard);
  }, [activeView]);

  const handleMenuNav = (id: MenuId) => {
    setActiveView(id);
    setActiveChat(null);
    setMenuOpen(false);
  };

  /* ── "now" home view ── */
  const renderNowView = () => (
    <div className="relative flex flex-col h-full">
      {/* Greeting header — "Hi Cherub" pinned top, news below */}
      <div className="relative z-20 px-5 pt-24 pb-2">
        <h1 className="text-2xl font-light text-foreground leading-tight">
          Hi,{" "}
          <span className="font-semibold bg-gradient-to-r from-[hsl(292,78%,63%)] to-[hsl(330,80%,65%)] bg-clip-text text-transparent">
            Cherub
          </span>
        </h1>
        <div className="h-[28px] overflow-hidden mt-1">
          <AnimatePresence mode="wait">
            <motion.p
              key={greetIdx}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.4 }}
              className="text-base font-medium text-foreground/80 flex items-center gap-1.5 cursor-pointer"
            >
              {AI_GREETINGS[greetIdx]}
              <ArrowRight size={16} strokeWidth={2.5} className="text-foreground/70 shrink-0" />
            </motion.p>
          </AnimatePresence>
        </div>
      </div>

      {/* Full-screen sphere + floating cards */}
      <div
        className="flex-1 relative flex items-center justify-center overflow-hidden"
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        {/* Sphere — large, centered */}
        <Suspense fallback={<div className="w-[300px] h-[300px] rounded-full bg-foreground/5 animate-pulse" />}>
          <AiSphere size={Math.min(570, window.innerWidth * 1.42)} mode="idle" className="-mt-[10%]" />
        </Suspense>

        {/* Floating mini cards — dynamic */}
        <AnimatePresence>
          {visibleCards.map((card, i) => {
            const positions = getSlotPositions(currentLayoutIdx);
            const pos = positions[card.slotIndex];
            const cat = CATEGORIES[card.category];
            const Icon = cat.icon;
            const delay = i * 1.1;
            const dur = 7 + (i % 3) * 1.5;
            const isNew = card.status === "new";
            const isDone = card.status === "done";
            const isProcessing = card.status === "processing";

            // Scatter: fly outward toward nearest screen edge
            const cardCenterX = pos.left + 20; // approximate center in %
            const cardCenterY = 50 + pos.y;    // approximate center in %
            // Direction vector from screen center (50,50) outward
            const dx = cardCenterX - 50;
            const dy = cardCenterY - 50;
            const mag = Math.sqrt(dx * dx + dy * dy) || 1;
            // Normalize and scale to fly well past screen edge
            const exitX = (dx / mag) * 400;
            const exitY = (dy / mag) * 400;

            // Determine exit: individual card swipe-left, global left swipe, or scatter
            const flyLeft = card.exitDirection === "left" || globalExitDirection === "left";

            return (
              <motion.button
                key={`float-${card.id}-${scatterKey}`}
                layout
                drag="x"
                dragConstraints={{ left: 0, right: 0 }}
                dragElastic={0.4}
                onDragEnd={(_e, info) => {
                  if (info.offset.x < -80) {
                    dismissCard(card.id);
                  }
                }}
                initial={{ opacity: 0, scale: 0.85 }}
                animate={{
                  opacity: 1,
                  scale: [1, 1.045, 1, 0.97, 1],
                  y: [0, -3.5, 0, 2, 0],
                  x: [0, 1.5, 0, -1.5, 0],
                }}
                exit={flyLeft ? {
                  opacity: 0,
                  scale: 0.6,
                  x: -400,
                  rotate: -15,
                  transition: { duration: 0.4, ease: [0.4, 0, 1, 1] },
                } : {
                  opacity: 0,
                  scale: 0.6,
                  x: exitX,
                  y: exitY,
                  rotate: (card.id % 2 === 0 ? 1 : -1) * (10 + card.id % 15),
                  transition: { duration: 0.45, ease: [0.4, 0, 1, 1] },
                }}
                transition={{
                  opacity: { duration: 0.8 },
                  scale: { duration: dur + 1, repeat: Infinity, ease: "easeInOut", delay: delay + 0.3 },
                  y: { duration: dur, repeat: Infinity, ease: "easeInOut", delay },
                  x: { duration: dur + 2, repeat: Infinity, ease: "easeInOut", delay: delay + 0.5 },
                }}
                onClick={() => {
                  if (isDone || isProcessing) {
                    const chatCard = card as ChatCard;
                    setCardChats((prev) => {
                      if (prev.find((c) => c.id === chatCard.id)) return prev;
                      return [chatCard, ...prev];
                    });
                    chatEntryView.current = activeView;
                    setChatMode(isDone ? "done" : "confirm");
                    setActiveChat(chatCard);
                    setActiveView("chat");
                  } else {
                    handleCardTap(card);
                  }
                }}
                className={`absolute glass-card-strong px-2.5 py-2 cursor-pointer hover:scale-105 transition-transform z-10 ${
                  isNew ? "ring-1 ring-pink-400/40" : isDone ? "ring-1 ring-green-400/40" : ""
                }`}
                style={{
                  left: `${pos.left}%`,
                  top: `calc(50% + ${pos.y}%)`,
                  width: `${33 + (card.id % 4) * 5}%`,
                  maxWidth: 180,
                  minWidth: 110,
                  borderRadius: 16,
                  boxShadow: "0 2px 12px rgba(0,0,0,0.06)",
                }}
              >
                <div className="flex items-center gap-1.5 mb-0.5">
                  <Icon size={12} strokeWidth={1.5} className="text-foreground/50" />
                  <span className="text-[10px] font-semibold tracking-wide text-foreground/50 uppercase truncate">
                    {cat.label}
                  </span>
                  {isNew && (
                    <span className="text-[9px] font-bold text-pink-500 uppercase tracking-wider">new</span>
                  )}
                  {isProcessing && (
                    <span className="shrink-0 w-2.5 h-2.5 rounded-full border-[1.5px] border-amber-400 border-t-transparent animate-spin" />
                  )}
                  {isDone && (
                    <span className="text-[9px] font-bold text-green-500 uppercase tracking-wider">done</span>
                  )}
                </div>
                <p className="text-[13px] font-medium text-foreground leading-snug line-clamp-3 text-left">
                  {card.title}
                </p>
              </motion.button>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );

  return (
    <div className="relative h-screen w-full max-w-md mx-auto overflow-hidden">
      {/* Background */}
      <img src={bgGradient} alt="" className="absolute inset-0 w-full h-full object-cover opacity-80" aria-hidden="true" />
      <div className="absolute inset-0 animate-bg-flow opacity-25" />
      <div className="absolute inset-0 bg-white/50" />

      <div className="relative z-10 flex flex-col h-full">
        {/* Hamburger button — top right */}
        <button
          onClick={() => setMenuOpen(true)}
          className="absolute top-14 right-4 z-30 p-2 rounded-full glass-card-strong"
        >
          <Menu size={20} strokeWidth={1.5} className="text-foreground/70" />
        </button>

        {/* Main content area */}
        <AnimatePresence mode="wait">
          {activeChat ? (
            <motion.div
              key={`chat-detail-${activeChat.id}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex-1 overflow-hidden"
            >
              <ChatDetailView card={activeChat} mode={chatMode} onBack={() => {
                const returnTo = chatEntryView.current;
                setActiveChat(null);
                if (returnTo) setActiveView(returnTo);
              }} />
            </motion.div>
          ) : activeView === "now" ? (
            <motion.div
              key="now"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex-1 overflow-hidden"
            >
              {renderNowView()}
            </motion.div>
          ) : (
            <motion.div
              key={activeView}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.25 }}
              className="flex-1 overflow-hidden"
            >
              {activeView === "chat" && (
                <ChatTimeline cardChats={cardChats} onOpenChat={(c, status) => { chatEntryView.current = "chat"; setChatMode(status === "processing" ? "confirm" : status === "action" ? "modify" : "done"); setActiveChat(c); }} />
              )}
              {activeView === "goals" && <GoalsView />}
              {activeView === "control" && <ControlPanel />}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

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
          className="max-h-[85vh] border-t-0 !bg-transparent"
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
                dismissCard(card.id);
              }}
              onModify={(card) => {
                setDrawerOpen(false);
                setSelectedCard(null);
                const chatCard = card as ChatCard;
                setCardChats((prev) => {
                  if (prev.find((c) => c.id === chatCard.id)) return prev;
                  return [chatCard, ...prev];
                });
                chatEntryView.current = activeView;
                setChatMode("modify");
                setActiveChat(chatCard);
                setActiveView("chat");
              }}
            />
          )}
        </DrawerContent>
      </Drawer>
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
    <div className="px-5 pb-6 pt-2 overflow-y-auto max-h-[75vh]">
      {/* Category */}
      <div className="flex items-center gap-1.5 mb-2">
        <Icon size={14} strokeWidth={1.5} className="text-foreground/50" />
        <span className="text-xs font-semibold tracking-wide text-foreground/50 uppercase">{cat.label}</span>
        {card.tag && (
          <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-foreground/10 text-foreground/50">
            {card.tag}
          </span>
        )}
      </div>

      {/* Title */}
      <h3 className="text-display text-[18px] leading-snug text-foreground mb-2.5 font-semibold">{card.title}</h3>

      {/* Description */}
      <p className="text-[15px] text-foreground/70 leading-relaxed mb-1.5">{card.line1}</p>
      <p className="text-[13px] text-foreground/55 leading-relaxed mb-4">{card.line2}</p>

      {/* Detail sections */}
      {card.detail && (
        <>
           {/* Scores */}
           <div className="grid grid-cols-4 gap-2 mb-4">
             {card.detail.scores.map((s) => (
               <div key={s.label} className="rounded-xl bg-foreground/5 py-2.5 text-center">
                 <div className={`text-lg font-bold ${s.label === "Risk" ? "text-green-600" : "text-foreground/80"}`}>
                   {s.value}
                 </div>
                 <div className="text-[12px] text-foreground/50 mt-0.5 font-medium">{s.label}</div>
               </div>
             ))}
           </div>

           {/* Will execute */}
           <div className="rounded-xl p-4 mb-4 border border-pink-200/40" style={{ background: "linear-gradient(135deg, rgba(225,92,230,0.08) 0%, rgba(225,92,230,0.04) 100%)" }}>
             <div className="text-[13px] font-bold mb-1.5 flex items-center gap-1.5">
               <Zap size={13} strokeWidth={2} color="hsl(292,78%,63%)" />
               <span className="bg-gradient-to-r from-[hsl(292,78%,63%)] to-[hsl(330,80%,65%)] bg-clip-text text-transparent">Will execute on confirm</span>
             </div>
             <p className="text-[15px] text-foreground font-medium leading-relaxed">{card.detail.willExecute}</p>
           </div>

           {/* Execution Plan */}
           <div className="mb-4">
             <div className="text-[13px] font-bold text-foreground uppercase tracking-wide mb-2">Execution Plan</div>
             <div className="flex flex-col gap-1.5">
               {card.detail.executionPlan.map((step, i) => (
                 <div key={i} className="flex items-center gap-2 rounded-xl bg-foreground/4 px-3 py-2.5">
                   <ArrowRight size={13} strokeWidth={1.5} className="text-foreground/40 shrink-0" />
                   <span className="text-[14px] text-foreground/65 flex-1">{step.text}</span>
                   <span className="text-[11px] text-foreground/35 bg-foreground/5 px-2 py-0.5 rounded-full whitespace-nowrap">{step.tool}</span>
                 </div>
               ))}
             </div>
           </div>

           {/* Data Sources */}
           <div className="mb-4 rounded-xl bg-foreground/[0.04] border border-foreground/[0.06] p-3.5">
             <div className="text-[13px] font-bold text-foreground/60 uppercase tracking-wide mb-2">Data Sources</div>
             {card.detail.dataSources.map((ds, i) => (
               <div key={i} className="flex items-start gap-2 mb-1.5 last:mb-0">
                 <span className="w-2 h-2 rounded-full bg-foreground/25 mt-1.5 shrink-0" />
                 <span className="text-[14px] text-foreground/65 leading-relaxed">{ds}</span>
               </div>
             ))}
           </div>

           {/* Impact & Permissions */}
           <p className="text-[14px] text-foreground/55 mb-1.5">
             <span className="font-bold text-foreground/70">Impact:</span> {card.detail.impact}
           </p>
           <p className="text-[14px] text-foreground/55 mb-4">
             <span className="font-bold text-foreground/70">Permissions:</span> {card.detail.permissions}
           </p>
        </>
      )}

      {/* Actions — Dismiss / Steer / Approve */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => onDismiss(card)}
          className="flex items-center justify-center gap-1.5 px-4 py-3 rounded-xl bg-foreground/5 hover:bg-foreground/10 transition-colors text-[13px] font-medium text-foreground/55"
        >
          <X size={13} strokeWidth={2} /> Dismiss
        </button>
        <button
          onClick={() => onModify(card)}
          className="flex items-center justify-center gap-1 px-3 py-3 rounded-xl bg-foreground/5 hover:bg-foreground/10 transition-colors text-[12px] font-medium text-foreground/55"
        >
          <Pencil size={11} strokeWidth={2} /> Steer
        </button>
        <button
          onClick={() => onExecute(card)}
          className="flex-1 flex items-center justify-center gap-1.5 px-4 py-3 rounded-xl bg-foreground text-background text-[13px] font-semibold hover:bg-foreground/85 transition-colors"
        >
          <Check size={13} strokeWidth={2.5} /> Approve
        </button>
      </div>
    </div>
  );
}
