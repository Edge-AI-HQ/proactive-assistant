import ManageAgentDialog from "./ManageAgentDialog";

type ModelItem = {
  id: string;
  ref: string;
};

interface AgentCardProps {
  username: string | null;
  status: string;
  planId: string | null;
  skillsCount: number;
  active: boolean;
  manageOpen: boolean;
  google?: {
    connected: boolean;
    email: string | null;
  };
  googleBusy: boolean;
  onOpenManage: () => void;
  onCloseManage: () => void;
  onChangePlan: () => void;
  onRepairRuntime: () => void;
  runtimeBusy: boolean;
  allowDeleteAccount: boolean;
  onDeleteAccount: () => void;
  onConnectGoogle: () => void;
  onDisconnectGoogle: () => void;
  models?: {
    current: string | null;
    available: ModelItem[];
  } | null;
  modelBusy: boolean;
  onChangeModel: (modelRef: string) => void;
  onLoadModels: () => Promise<void>;
}

const getStatusDisplay = (status: string): { text: string; color: string } => {
  switch (status) {
    case "running":
      return { text: "Running", color: "text-pin-mint" };
    case "creating":
      return { text: "Creating...", color: "text-amber-600" };
    case "stopped":
      return { text: "Starting...", color: "text-amber-600" };
    case "missing":
      return { text: "Provisioning...", color: "text-amber-600" };
    case "error":
      return { text: "Error", color: "text-destructive" };
    default:
      return { text: "Starting up...", color: "text-amber-600" };
  }
};

const formatModelName = (modelRef: string | null | undefined): string => {
  if (!modelRef) return "Default";
  const tail = modelRef.split("/").pop() || modelRef;
  return tail.length > 12 ? `${tail.slice(0, 12)}...` : tail;
};

const AgentCard = ({
  username,
  status,
  planId,
  skillsCount,
  active,
  manageOpen,
  google,
  googleBusy,
  onOpenManage,
  onCloseManage,
  onChangePlan,
  onRepairRuntime,
  runtimeBusy,
  allowDeleteAccount,
  onDeleteAccount,
  onConnectGoogle,
  onDisconnectGoogle,
  models,
  modelBusy,
  onChangeModel,
  onLoadModels,
}: AgentCardProps) => {
  const handle = username ? `@${username}` : "@PINClaw_AI_bot";
  const statusDisplay = getStatusDisplay(status);
  const modelName = formatModelName(models?.current);

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
      <div className="relative pt-14 animate-fade-in">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 z-10">
          <div className="avatar-ring-glow" style={{ width: 100, height: 100 }}>
            <img
              src="/mini/avatar-pinai.png"
              alt="PIN Claw"
              className="w-[96px] h-[96px] rounded-full object-cover shadow-md bg-white"
            />
          </div>
        </div>

        <div
          className={`rounded-3xl p-6 pt-16 transition-all ${
            active ? "glass-card-home" : "bg-card border border-border/40 shadow-sm"
          }`}
        >
          <div className="flex flex-col items-center text-center mb-5">
            <h3 className="text-2xl font-bold text-foreground">PIN Claw</h3>
            {active && (
              <span className="flex items-center justify-center gap-1.5 mt-1">
                <span className="w-2.5 h-2.5 rounded-full status-active-dot animate-active-breathe" />
                <span className="text-sm font-semibold status-active-text">Active</span>
              </span>
            )}
            <p className="text-base font-medium text-foreground/70 mt-1">All-in-One AI Assistant</p>
            <p className="text-sm font-semibold mt-0.5 text-primary">{handle}</p>
          </div>

          <button
            type="button"
            onClick={onChangePlan}
            className="w-full rounded-xl px-4 py-2.5 flex items-center justify-between glass-stat-box mb-4 text-left btn-press hover:bg-white/40 transition-colors"
          >
            <span className="text-xs text-muted-foreground font-medium">Current Plan</span>
            <span className="text-sm font-semibold text-foreground">{planId || "Free"}</span>
          </button>

          <div className="flex items-center gap-2.5 mb-5">
            <div className="flex-1 rounded-xl px-2 py-3.5 text-center glass-stat-box">
              <p className="text-[10px] text-muted-foreground whitespace-nowrap">Status</p>
              <p className={`text-sm font-bold whitespace-nowrap ${statusDisplay.color}`}>{statusDisplay.text}</p>
            </div>
            <div className="flex-1 rounded-xl px-2 py-3.5 text-center glass-stat-box">
              <p className="text-[10px] text-muted-foreground whitespace-nowrap">Skills</p>
              <p className="text-xl font-bold text-foreground">{skillsCount}</p>
            </div>
            <div className="flex-1 rounded-xl px-2 py-3.5 text-center glass-stat-box">
              <p className="text-[10px] text-muted-foreground whitespace-nowrap">Model</p>
              <p className="text-sm font-bold text-foreground whitespace-nowrap">{modelName}</p>
            </div>
          </div>

          <div className="space-y-2.5">
            <button
              onClick={handleChat}
              className="w-full flex items-center justify-center gap-2 rounded-2xl py-3.5 text-sm font-semibold text-white btn-press bg-foreground shadow-lg"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
              Chat with PIN Claw
            </button>
            <button
              onClick={onOpenManage}
              className="w-full flex items-center justify-center gap-2 rounded-2xl py-3 text-sm font-medium text-foreground btn-press glass-stat-box hover:bg-white/40 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              Manage Agent
            </button>
          </div>
        </div>
      </div>

      <ManageAgentDialog
        open={manageOpen}
        onClose={onCloseManage}
        planId={planId}
        runtimeStatus={status}
        google={google}
        googleBusy={googleBusy}
        onChangePlan={onChangePlan}
        onRepairRuntime={onRepairRuntime}
        runtimeBusy={runtimeBusy}
        allowDeleteAccount={allowDeleteAccount}
        onDeleteAccount={onDeleteAccount}
        onConnectGoogle={onConnectGoogle}
        onDisconnectGoogle={onDisconnectGoogle}
        models={models}
        modelBusy={modelBusy}
        onChangeModel={onChangeModel}
        onLoadModels={onLoadModels}
      />
    </>
  );
};

export default AgentCard;
