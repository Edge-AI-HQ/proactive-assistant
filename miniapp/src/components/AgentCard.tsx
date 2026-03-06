import ManageAgentDialog from "./ManageAgentDialog";

interface AgentCardProps {
  username: string | null;
  status: string;
  planId: string | null;
  active: boolean;
  manageOpen: boolean;
  google: {
    connected: boolean;
    email: string | null;
  };
  googleBusy: boolean;
  onOpenManage: () => void;
  onCloseManage: () => void;
  onChangePlan: () => void;
  onDeleteAccount: () => void;
  onConnectGoogle: () => void;
  onDisconnectGoogle: () => void;
}

const getStatusDisplay = (status: string): { text: string; color: string } => {
  switch (status) {
    case "running":
      return { text: "Running", color: "text-pin-mint" };
    case "creating":
      return { text: "Setting up...", color: "text-amber-600" };
    case "stopped":
      return { text: "Stopped", color: "text-muted-foreground" };
    case "error":
      return { text: "Error", color: "text-destructive" };
    case "missing":
      return { text: "Initializing...", color: "text-amber-600" };
    default:
      return { text: "Unknown", color: "text-muted-foreground" };
  }
};

const AgentCard = ({
  username,
  status,
  planId,
  active,
  manageOpen,
  google,
  googleBusy,
  onOpenManage,
  onCloseManage,
  onChangePlan,
  onDeleteAccount,
  onConnectGoogle,
  onDisconnectGoogle,
}: AgentCardProps) => {
  const statusDisplay = getStatusDisplay(status);

  const handleChat = () => {
    // Close the mini app — returns user to Telegram where they can chat with the bot
    if (window.Telegram?.WebApp?.close) {
      window.Telegram.WebApp.close();
    } else if (username) {
      window.open(`https://t.me/${username}`, "_blank");
    }
  };

  return (
    <>
      <div className={`rounded-2xl p-5 transition-all animate-fade-in ${active ? "bg-white/45 backdrop-blur-xl border border-white/60 shadow-[inset_0_1px_1px_hsl(0_0%_100%/0.5),0_4px_24px_-4px_hsl(270_30%_60%/0.1)]" : "bg-card shadow-sm"}`}>
        <div className="flex items-start gap-4">
          <div className="relative shrink-0">
            <div className="avatar-ring-glow" style={{ width: 56, height: 56 }}>
              <img
                src="/tg-subscription-mini/avatar-pinai.png"
                alt="PIN AI"
                className="w-[52px] h-[52px] rounded-full object-cover shadow-md"
              />
            </div>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <h3 className="text-base font-semibold text-foreground">PIN AI</h3>
              {active && (
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full status-active-dot animate-pulse-soft" />
                  <span className="text-[10px] status-active-text font-medium">Active 24/7</span>
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground mb-1">All-in-One AI Assistant</p>
            {username && (
              <p className="text-xs text-foreground/70 font-medium">@{username}</p>
            )}
          </div>
          {/* Plan Badge */}
          <div className="shrink-0 rounded-xl bg-secondary px-3 py-1.5 text-center">
            <p className="text-[10px] text-muted-foreground font-medium">Plan</p>
            <p className="text-xs font-semibold text-foreground">{planId || "Free"}</p>
          </div>
        </div>

        {/* Status */}
        <div className="mt-4 mb-4 glass-stat-box rounded-xl px-4 py-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Status</span>
            <span className={`text-xs font-semibold ${statusDisplay.color}`}>
              {statusDisplay.text}
            </span>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex gap-2.5">
          <button
            onClick={handleChat}
            className="flex-1 flex items-center justify-center gap-1.5 btn-dark rounded-xl py-2.5 text-sm font-semibold btn-press shadow-md"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            Chat
          </button>
          <button
            onClick={onOpenManage}
            className="flex-1 flex items-center justify-center gap-1.5 bg-secondary text-foreground rounded-xl py-2.5 text-sm font-semibold btn-press hover:bg-secondary/80 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            Manage
          </button>
        </div>
      </div>

      <ManageAgentDialog
        open={manageOpen}
        onClose={onCloseManage}
        planId={planId}
        google={google}
        googleBusy={googleBusy}
        onChangePlan={onChangePlan}
        onDeleteAccount={onDeleteAccount}
        onConnectGoogle={onConnectGoogle}
        onDisconnectGoogle={onDisconnectGoogle}
      />
    </>
  );
};

export default AgentCard;
