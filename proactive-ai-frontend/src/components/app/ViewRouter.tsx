import { motion, AnimatePresence } from "framer-motion";
import ChatDetailView, { type ChatCard } from "@/components/chat/ChatDetailView";
import AmbientView, { type TimelineEntry as AmbientTimelineEntry } from "@/components/ambient/AmbientView";
import AccountPanel from "@/components/account/AccountPanel";
import NowView from "@/components/now/NowView";
import SwipeBackLayer from "@/components/app/SwipeBackLayer";
import MirrorMobile from "@/components/profile/MirrorMobile";
import RealControlPanel from "@/components/connect/ControlPanel";
import CardTimeline from "@/components/tasks/CardTimeline";
import type { Intent } from "@/components/now/card-model";
import type { MenuId, SettingsSubPage } from "@/components/app/useAppNavigation";
import type { WeatherData } from "@/hooks/useWeather";
import type { ComposioState } from "@/hooks/useComposio";
import type { VoicePermissionState } from "@/hooks/useVoicePermission";
import type { IntentCard } from "@pin-ai/core";
import type { LiveSession } from "@/services/ambient/live-session";

interface ViewRouterProps {
  // ── routing state ──
  // (real card chat is a portal sheet now — CardChatOverlay in AppLayout —
  //  so only the legacy mock activeChat path still routes through here)
  activeChat: ChatCard | null;
  activeView: MenuId;
  // ── shared backend handles ──
  composio: ComposioState;
  // ── card chat (legacy activeChat branch) ──
  onCardChatBack: () => void;
  // ── NOW view ──
  displayName: string;
  sphereCards: Intent[];
  ambientOn: boolean;
  ambientTogglePending: boolean;
  weather: WeatherData | null;
  feedLoading: boolean;
  connectorCount: number;
  connectorsKnown: boolean;
  voiceState: VoicePermissionState;
  onOpenAmbient: () => void;
  onToggleAmbient: () => void;
  onEnableVoice: () => void;
  onReviewPermissions: () => void;
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
 * cross-fades between the active full-screen surface: legacy mock card chat
 * (`activeChat`), then the 6 top-level views keyed by `activeView`. Purely a
 * dispatcher — every action it fires arrives as a prop, so AppLayout keeps
 * ownership of all state + side effects. The REAL card chat no longer routes
 * through here: it's a portal sheet (CardChatOverlay) mounted by AppLayout,
 * so the view underneath stays live while the sheet covers it.
 */
export default function ViewRouter({
  activeChat,
  activeView,
  composio,
  onCardChatBack,
  displayName,
  sphereCards,
  ambientOn,
  ambientTogglePending,
  weather,
  feedLoading,
  connectorCount,
  connectorsKnown,
  voiceState,
  onOpenAmbient,
  onToggleAmbient,
  onEnableVoice,
  onReviewPermissions,
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
        key={activeChat ? `chat-detail-${activeChat.id}` : activeView}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        className="flex-1 overflow-hidden"
      >
        {activeChat ? (
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
            feedLoading={feedLoading}
            connectorCount={connectorCount}
            connectorsKnown={connectorsKnown}
            voiceState={voiceState}
            onOpenAmbient={onOpenAmbient}
            onToggleAmbient={onToggleAmbient}
            onEnableVoice={onEnableVoice}
            onConnect={onConnectMore}
            onReviewPermissions={onReviewPermissions}
            onCardTap={onSphereCardTap}
          />
        ) : activeView === "chat" ? (
          /* Real card history (old AppShell CHAT view). Reuses the
             shared /api/cards state from this layout so TASKS does not
             refetch on every tab entry. */
          <CardTimeline
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
          /* MIRROR —— profile / memory / goals。移动布局 shell（数据走
             @pin-ai/state hook、展示复用 @pin-ai/ui-web panel）。 */
          <div className="h-full min-h-0 overflow-hidden">
            <MirrorMobile />
          </div>
        ) : activeView === "connect" ? (
          /* Real data + device connections + auto settings (old AppShell
             CONTROL view): wire Composio, devices, auto-generate and
             auto-evolution. */
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
        ) : null}
      </motion.div>
    </AnimatePresence>
  );
}
