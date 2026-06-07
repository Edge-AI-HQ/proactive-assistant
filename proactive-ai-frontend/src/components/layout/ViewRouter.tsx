import { motion, AnimatePresence } from "framer-motion";
import ChatDetailView, { type ChatCard } from "@/components/chat/ChatDetailView";
import ConversationView from "@/components/conversation/ConversationView";
import AmbientView, { type TimelineEntry as AmbientTimelineEntry } from "@/components/ambient/AmbientView";
import AccountPanel from "@/components/account/AccountPanel";
import NowView from "@/components/now/NowView";
import SwipeBackLayer from "@/components/layout/SwipeBackLayer";
import RealGoalsView from "@/components/GoalsView";
import RealControlPanel from "@/components/ControlPanel";
import RealChatTimeline from "@/components/ChatTimeline";
import { realIntentToChatCard, type Intent } from "@/components/now/cardModel";
import type { CardActions } from "@/components/card/CardStateContext";
import type { MenuId, SettingsSubPage } from "@/components/layout/useAppNavigation";
import type { WeatherData } from "@/hooks/useWeather";
import type { ComposioState } from "@/hooks/useComposio";
import type { IntentCard } from "@/types/intent-card";
import type { LiveSession } from "@/services/ambient/live-session";

interface ViewRouterProps {
  // ── routing state ──
  chatTarget: { card: IntentCard; bootstrap?: string } | null;
  activeChat: ChatCard | null;
  activeView: MenuId;
  // ── shared backend handles ──
  cardActions: CardActions;
  composio: ComposioState;
  // ── card chat (chatTarget + legacy activeChat branches) ──
  onCardChatBack: () => void;
  // ── PROACTIVE view (full-screen ConversationView, kind="proactive") ──
  onProactiveBack: () => void;
  // ── NOW view ──
  displayName: string;
  sphereCards: Intent[];
  ambientOn: boolean;
  ambientTogglePending: boolean;
  weather: WeatherData | null;
  onOpenAmbient: () => void;
  onToggleAmbient: () => void;
  onSphereCardTap: (id: number) => void;
  // ── TASKS (real card history) ──
  onTasksOpenChat: (card: IntentCard, bootstrap?: string) => void;
  onTasksOpenCardDetail: (card: IntentCard) => void;
  // ── AMBIENT ──
  onConnectMore: () => void;
  onOpenFullscreen: (session: LiveSession) => void;
  onAmbientAction: (entry: AmbientTimelineEntry) => void;
  // ── SETTING (account) ──
  settingsSubPage: SettingsSubPage;
  onSubPageChange: (p: SettingsSubPage) => void;
  userName: string;
  avatarLetter: string;
  userEmail: string | undefined;
  onSignOut: () => void;
  onDeleteAccount: () => Promise<void>;
}

/**
 * Main content router. The single AnimatePresence + keyed motion.div that
 * cross-fades between the active full-screen surface: card chat (real
 * `chatTarget` or legacy `activeChat`), then the 6 top-level views keyed by
 * `activeView`. Purely a dispatcher — every action it fires arrives as a
 * prop, so AppLayout keeps ownership of all state + side effects.
 */
export default function ViewRouter({
  chatTarget,
  activeChat,
  activeView,
  cardActions,
  composio,
  onCardChatBack,
  onProactiveBack,
  displayName,
  sphereCards,
  ambientOn,
  ambientTogglePending,
  weather,
  onOpenAmbient,
  onToggleAmbient,
  onSphereCardTap,
  onTasksOpenChat,
  onTasksOpenCardDetail,
  onConnectMore,
  onOpenFullscreen,
  onAmbientAction,
  settingsSubPage,
  onSubPageChange,
  userName,
  avatarLetter,
  userEmail,
  onSignOut,
  onDeleteAccount,
}: ViewRouterProps) {
  return (
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
          /* Real card chat: ChatDetailView now wraps MainChatView with
             session_key = `card-thread-<cardId>`. `bootstrap` is the
             Confirm-path's primaryAction text; the shared chat runtime
             auto-fires it only when the thread is empty. */
          <SwipeBackLayer onBack={onCardChatBack} className="h-full">
            <ChatDetailView
              card={realIntentToChatCard(chatTarget.card)}
              runId={chatTarget.card.id}
              bootstrap={chatTarget.bootstrap}
              onBack={onCardChatBack}
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
          </SwipeBackLayer>
        ) : activeChat ? (
          /* Legacy mock-card path. Kept so type-checking stays honest
             if mock data is reintroduced for demos. */
          <SwipeBackLayer onBack={onCardChatBack} className="h-full">
            <ChatDetailView
              card={activeChat as ChatCard}
              onBack={onCardChatBack}
            />
          </SwipeBackLayer>
        ) : activeView === "now" ? (
          <NowView
            displayName={displayName}
            sphereCards={sphereCards}
            ambientOn={ambientOn}
            ambientTogglePending={ambientTogglePending}
            weather={weather}
            onOpenAmbient={onOpenAmbient}
            onToggleAmbient={onToggleAmbient}
            onCardTap={onSphereCardTap}
          />
        ) : activeView === "chat" ? (
          /* Real card history (old AppShell CHAT view). Reuses the
             shared /api/cards state from this layout so TASKS does not
             refetch on every tab entry. */
          <RealChatTimeline
            composio={composio}
            onOpenChat={onTasksOpenChat}
            onOpenCardDetail={onTasksOpenCardDetail}
          />
        ) : activeView === "ambient" ? (
          <AmbientView
            onConnectMore={onConnectMore}
            onOpenFullscreen={onOpenFullscreen}
            onAmbientAction={onAmbientAction}
          />
        ) : activeView === "profile" ? (
          /* Real goals/memory/skill page (old AppShell GOALS view). */
          <div className="h-full min-h-0 overflow-hidden">
            <RealGoalsView composio={composio} />
          </div>
        ) : activeView === "connect" ? (
          /* Real data + device connections + auto settings (old AppShell
             CONTROL view). Replaces Lovable's hardcoded ConnectPanel
             so users can actually wire Composio, devices, auto-generate
             and auto-dreaming. */
          <div className="h-full overflow-y-auto">
            <RealControlPanel composio={composio} />
          </div>
        ) : activeView === "account" ? (
          <AccountPanel
            subPage={settingsSubPage}
            onSubPageChange={onSubPageChange}
            userName={userName}
            avatarLetter={avatarLetter}
            userEmail={userEmail}
            onSignOut={onSignOut}
            onDeleteAccount={onDeleteAccount}
          />
        ) : activeView === "proactive" ? (
          /* Proactive agent — the unified ConversationView (kind defaults
             to "proactive", heartbeat-capable). Full-screen like main chat;
             the in-chat back button returns to NOW. */
          <ConversationView onBack={onProactiveBack} />
        ) : null}
      </motion.div>
    </AnimatePresence>
  );
}
