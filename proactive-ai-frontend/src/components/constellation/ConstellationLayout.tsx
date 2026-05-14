import { useCallback, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ListChecks,
  Menu,
  Plug,
  Radio,
  Settings,
  Sparkles,
  Target,
  User as UserIcon,
  X,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";
import { useCardActions } from "@/hooks/useCardActions";
import { useCards } from "@/hooks/useCards";
import { useComposio } from "@/hooks/useComposio";
import { intentCardsToIntents } from "@/lib/cardAdapter";
import type { IntentCard } from "@/types/intent-card";
import type { Intent } from "@/types/constellation";

import CardChat from "@/components/CardChat";
import ChatTimeline from "@/components/ChatTimeline";
import ControlPanel from "@/components/ControlPanel";
import GoalsView from "@/components/GoalsView";

import AccountPanel from "./AccountPanel";
import AiSphere from "./AiSphere";
import AmbientView from "./AmbientView";
import CardDrawerDetail from "./CardDrawerDetail";
import ConnectPanel from "./ConnectPanel";
import NowFeed from "./NowFeed";
import Sphere3DCards, { type Sphere3DCardItem } from "./Sphere3DCards";
import { categoryFor } from "./categoryMeta";

type ViewId =
  | "now"
  | "ambient"
  | "tasks"
  | "profile"
  | "control"
  | "connect"
  | "account";

interface MenuItem {
  id: ViewId;
  label: string;
  icon: LucideIcon;
}

const MENU_ITEMS: MenuItem[] = [
  { id: "now", label: "NOW", icon: Zap },
  { id: "ambient", label: "AMBIENT", icon: Radio },
  { id: "tasks", label: "TASKS", icon: ListChecks },
  { id: "profile", label: "PROFILE", icon: Target },
  { id: "connect", label: "CONNECT", icon: Plug },
  { id: "control", label: "CONTROL", icon: Settings },
  { id: "account", label: "ACCOUNT", icon: UserIcon },
];

interface ChatTarget {
  card: IntentCard;
  bootstrapMessage?: string;
}

export default function ConstellationLayout() {
  const { user } = useAuth();
  const cardsState = useCards();
  const composio = useComposio();
  const [view, setView] = useState<ViewId>("now");
  const [menuOpen, setMenuOpen] = useState(false);
  const [selectedIntent, setSelectedIntent] = useState<Intent | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [chatTarget, setChatTarget] = useState<ChatTarget | null>(null);

  const handleOpenChat = useCallback(
    (card: IntentCard, bootstrapMessage: string) => {
      setChatTarget({
        card,
        bootstrapMessage: bootstrapMessage.trim().length > 0 ? bootstrapMessage : undefined,
      });
      setDrawerOpen(false);
      setSelectedIntent(null);
    },
    [],
  );

  const actions = useCardActions({ onOpenChat: handleOpenChat });

  /** IntentCard[] from /api/cards, filtered by dismissedIds, capped to a sane
   *  count for sphere readability. NowFeed shows everything. */
  const visibleCards: IntentCard[] = useMemo(() => {
    return cardsState.cards
      .filter((c) => !actions.dismissedIds.has(c.card.id))
      .map((c) => c.card);
  }, [cardsState.cards, actions.dismissedIds]);

  const intents: Intent[] = useMemo(
    () =>
      intentCardsToIntents(visibleCards, {
        processingIds: actions.processingIds,
        doneIds: actions.doneIds,
      }),
    [visibleCards, actions.processingIds, actions.doneIds],
  );

  /** Sphere shows top N most-urgent intents to avoid visual chaos. */
  const sphereItems: Sphere3DCardItem[] = useMemo(() => {
    return intents.slice(0, 10).map((i) => {
      const meta = categoryFor(i.category);
      return {
        id: i.id,
        category: i.category,
        title: i.title,
        icon: meta.icon,
        categoryLabel: meta.label,
        complexity: i.complexity,
        status: i.status,
      };
    });
  }, [intents]);

  const findIntent = useCallback(
    (intentId: number): Intent | undefined => intents.find((i) => i.id === intentId),
    [intents],
  );

  const findOriginalCard = useCallback(
    (originalId: string): IntentCard | undefined =>
      visibleCards.find((c) => c.id === originalId),
    [visibleCards],
  );

  const openDetail = useCallback((intent: Intent) => {
    setSelectedIntent(intent);
    setDrawerOpen(true);
  }, []);

  return (
    <div className="relative min-h-screen w-screen bg-background text-foreground overflow-hidden">
      {/* Aurora background — fixed, doesn't scroll with content */}
      <div
        aria-hidden
        className="aurora-layer aurora-layer-1 fixed inset-0 z-0 pointer-events-none"
      />
      <div
        aria-hidden
        className="aurora-layer aurora-layer-2 fixed inset-0 z-0 pointer-events-none"
      />
      <div
        aria-hidden
        className="aurora-layer aurora-layer-3 fixed inset-0 z-0 pointer-events-none"
      />

      {/* Top bar */}
      <header
        className="relative z-30 flex items-center justify-between px-4 pt-[calc(env(safe-area-inset-top,0px)+10px)] pb-2"
      >
        <button
          aria-label="Open menu"
          onClick={() => setMenuOpen(true)}
          className="w-10 h-10 rounded-xl glass-card flex items-center justify-center text-foreground/70 hover:text-foreground transition-colors"
        >
          <Menu size={18} strokeWidth={1.8} />
        </button>
        <div className="text-[11px] font-bold text-foreground/55 uppercase tracking-[0.2em]">
          {MENU_ITEMS.find((m) => m.id === view)?.label ?? "NOW"}
        </div>
        <div className="w-10 h-10" />
      </header>

      {/* Main content */}
      <main className="relative z-10 h-[calc(100vh-58px)] h-[calc(100dvh-58px)] overflow-hidden">
        {view === "now" && (
          <NowView
            intents={intents}
            sphereItems={sphereItems}
            onTapIntent={openDetail}
            onApprove={(intent) => {
              const card = findOriginalCard(intent.originalId);
              if (card) void actions.confirm(card);
            }}
            onModify={(intent) => {
              const card = findOriginalCard(intent.originalId);
              if (card) void actions.modify(card);
            }}
            onDismiss={(intent) => {
              const card = findOriginalCard(intent.originalId);
              if (card) void actions.dismiss(card);
            }}
          />
        )}
        {view === "ambient" && <AmbientView />}
        {view === "tasks" && (
          <div className="h-full overflow-y-auto px-4 pt-4 pb-12">
            <div className="max-w-2xl mx-auto">
              <div className="flex items-center gap-2 mb-1">
                <ListChecks size={16} className="text-foreground/55" />
                <span className="text-[11px] font-bold text-foreground/55 uppercase tracking-wider">
                  Tasks
                </span>
              </div>
              <h1 className="text-display text-[26px] font-semibold text-foreground mb-4">
                Card history
              </h1>
              <ChatTimeline
                processingIds={actions.processingIds}
                doneIds={actions.doneIds}
                confirmedIds={actions.confirmedIds}
                dismissedIds={actions.dismissedIds}
                chattedIds={actions.chattedIds}
                onOpenChat={(card, bootstrapMessage) => {
                  handleOpenChat(card, bootstrapMessage ?? "");
                }}
                onConfirmId={actions.markConfirmed}
                onDismissId={actions.markDismissed}
                onDoneId={actions.markDone}
                onProcessingId={actions.markProcessing}
                onChattedId={actions.markChatted}
              />
            </div>
          </div>
        )}
        {view === "profile" && (
          <div className="h-full overflow-y-auto px-4 pt-4 pb-12">
            <GoalsView composio={composio} />
          </div>
        )}
        {view === "control" && (
          <div className="h-full overflow-y-auto px-4 pt-4 pb-12">
            <ControlPanel composio={composio} />
          </div>
        )}
        {view === "connect" && (
          <ConnectPanel onManage={() => setView("control")} />
        )}
        {view === "account" && <AccountPanel />}
      </main>

      {/* Card detail drawer */}
      <CardDrawerDetail
        intent={selectedIntent}
        open={drawerOpen}
        onOpenChange={(open) => {
          setDrawerOpen(open);
          if (!open) setSelectedIntent(null);
        }}
        onApprove={(intent) => {
          const card = findOriginalCard(intent.originalId);
          if (card) void actions.confirm(card);
        }}
        onModify={(intent) => {
          const card = findOriginalCard(intent.originalId);
          if (card) void actions.modify(card);
        }}
        onDismiss={(intent) => {
          const card = findOriginalCard(intent.originalId);
          if (card) void actions.dismiss(card);
          setDrawerOpen(false);
          setSelectedIntent(null);
        }}
        onChat={(intent) => {
          const card = findOriginalCard(intent.originalId);
          if (card) actions.openChat(card);
        }}
      />

      {/* Fullscreen card chat overlay (Approve / Modify / Chat → MainChatView) */}
      <AnimatePresence>
        {chatTarget && (
          <motion.div
            key="card-chat"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="fixed inset-0 z-40 bg-background"
          >
            <CardChat
              card={chatTarget.card}
              bootstrapMessage={chatTarget.bootstrapMessage}
              onBack={() => setChatTarget(null)}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Side menu */}
      <AnimatePresence>
        {menuOpen && (
          <>
            <motion.div
              key="menu-scrim"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
              onClick={() => setMenuOpen(false)}
            />
            <motion.aside
              key="menu-panel"
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ type: "spring", damping: 28, stiffness: 280 }}
              className="fixed left-0 top-0 bottom-0 z-50 w-[78%] max-w-[320px] bg-background/95 backdrop-blur-xl border-r border-foreground/5 flex flex-col"
              style={{
                paddingTop: "calc(env(safe-area-inset-top, 0px) + 16px)",
                paddingBottom: "max(env(safe-area-inset-bottom, 0px), 12px)",
              }}
            >
              <div className="flex items-center justify-between px-5 pb-4">
                <div className="flex items-center gap-2">
                  <Sparkles size={16} className="text-foreground/60" />
                  <span className="text-display text-[18px] font-semibold text-foreground">
                    Proactive AI
                  </span>
                </div>
                <button
                  aria-label="Close menu"
                  onClick={() => setMenuOpen(false)}
                  className="w-9 h-9 rounded-lg hover:bg-foreground/5 flex items-center justify-center text-foreground/60"
                >
                  <X size={16} strokeWidth={1.8} />
                </button>
              </div>
              <nav className="flex-1 px-3 overflow-y-auto">
                {MENU_ITEMS.map((item) => {
                  const Icon = item.icon;
                  const active = item.id === view;
                  return (
                    <button
                      key={item.id}
                      onClick={() => {
                        setView(item.id);
                        setMenuOpen(false);
                      }}
                      className={`w-full flex items-center gap-3 px-3 py-3 rounded-xl mb-1 transition-colors text-left ${
                        active
                          ? "bg-foreground/5 text-foreground"
                          : "text-foreground/65 hover:bg-foreground/[0.03]"
                      }`}
                    >
                      <Icon size={16} strokeWidth={1.6} />
                      <span className="text-[14px] font-medium tracking-wide">
                        {item.label}
                      </span>
                    </button>
                  );
                })}
              </nav>
              <div className="px-5 py-3 border-t border-foreground/5">
                <div className="text-[11px] text-foreground/45 truncate">
                  {user?.email ?? "Signed in"}
                </div>
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ── NOW view: AiSphere + Sphere3DCards as landing; NowFeed slides up ── */

interface NowViewProps {
  intents: Intent[];
  sphereItems: Sphere3DCardItem[];
  onTapIntent: (intent: Intent) => void;
  onApprove: (intent: Intent) => void;
  onModify: (intent: Intent) => void;
  onDismiss: (intent: Intent) => void;
}

function NowView({
  intents,
  sphereItems,
  onTapIntent,
  onApprove,
  onModify,
  onDismiss,
}: NowViewProps) {
  const handleSphereTap = useCallback(
    (intentId: number) => {
      const i = intents.find((it) => it.id === intentId);
      if (i) onTapIntent(i);
    },
    [intents, onTapIntent],
  );

  const Landing = useCallback(
    () => (
      <div className="relative w-full h-[60vh] flex items-center justify-center">
        <Sphere3DCards
          items={sphereItems}
          onCardTap={handleSphereTap}
          cacheKey="constellation-now"
        />
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <AiSphere size={220} />
        </div>
      </div>
    ),
    [sphereItems, handleSphereTap],
  );

  return (
    <NowFeed
      intents={intents}
      onTap={onTapIntent}
      onApprove={onApprove}
      onModify={onModify}
      onDismiss={onDismiss}
      LandingOverride={Landing}
    />
  );
}
