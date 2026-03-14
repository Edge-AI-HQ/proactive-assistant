import { useState } from "react";
import { createPortal } from "react-dom";
import ManageAgentDialog from "./ManageAgentDialog";
import DataConnectionsDialog from "./DataConnectionsDialog";
import SkillsDialog from "./SkillsDialog";
import ModelPickerDialog, { formatModelName } from "./ModelPickerDialog";
import { decideDataConnectorsAction } from "./agentCardActions";

type ModelItem = {
  id: string;
  ref: string;
};

type SkillItem = {
  key: string;
  name: string;
  description: string;
  installed: boolean;
  enabled: boolean;
};

interface AgentCardProps {
  username: string | null;
  status: string;
  planId: string | null;
  skillsCount: number;
  skills: SkillItem[];
  active: boolean;
  manageOpen: boolean;
  credits: { remaining: number; total: number } | null;
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
  onBlockedAction: (action: "model" | "chat" | "data") => void;
}

const getStatusDisplay = (
  status: string,
): { text: string; dotColor: string; textColor: string } => {
  switch (status) {
    case "running":
      return {
        text: "Running",
        dotColor: "bg-green-400",
        textColor: "text-green-700",
      };
    case "creating":
      return {
        text: "Creating...",
        dotColor: "bg-yellow-400 animate-pulse",
        textColor: "text-yellow-700",
      };
    case "stopped":
      return {
        text: "Starting...",
        dotColor: "bg-yellow-400 animate-pulse",
        textColor: "text-amber-600",
      };
    case "missing":
      return {
        text: "Provisioning...",
        dotColor: "bg-yellow-400 animate-pulse",
        textColor: "text-amber-600",
      };
    case "error":
      return {
        text: "Error",
        dotColor: "bg-red-400",
        textColor: "text-destructive",
      };
    default:
      return {
        text: "Starting up...",
        dotColor: "bg-yellow-400 animate-pulse",
        textColor: "text-amber-600",
      };
  }
};

const AgentCard = ({
  username,
  status,
  planId,
  skillsCount,
  skills,
  active,
  manageOpen,
  credits,
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
  onBlockedAction,
}: AgentCardProps) => {
  const [showData, setShowData] = useState(false);
  const [showSkills, setShowSkills] = useState(false);
  const [showModel, setShowModel] = useState(false);
  const [showRepairConfirm, setShowRepairConfirm] = useState(false);

  const handle = username ? `@${username}` : "@PINClaw_AI_bot";
  const statusDisplay = getStatusDisplay(status);
  const modelsLoaded = models != null;
  const modelName = formatModelName(models?.current, models?.available, modelsLoaded);
  const creditsDisplay = credits ? Math.floor(credits.remaining).toLocaleString() : "Loading...";
  const isRuntimeRunning = status === "running";

  const handleChat = () => {
    if (!isRuntimeRunning) {
      onBlockedAction("chat");
      return;
    }
    if (window.Telegram?.WebApp?.close) {
      window.Telegram.WebApp.close();
    } else if (username) {
      window.open(`https://t.me/${username}`, "_blank");
    }
  };

  const googleConnectedCount = google?.connected ? 1 : 0;

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

        <div className="rounded-3xl p-6 pt-16 glass-card-home">
          <div className="flex flex-col items-center text-center mb-5">
            <h3 className="text-2xl font-bold text-foreground drop-shadow-[0_1px_2px_rgba(255,255,255,0.8)]">
              PIN Claw
            </h3>
            <p className="text-base font-medium text-foreground/70 mt-1 drop-shadow-[0_1px_2px_rgba(255,255,255,0.8)]">
              All-in-One AI Assistant
            </p>
            <p
              className="text-sm font-semibold mt-0.5 drop-shadow-[0_1px_2px_rgba(255,255,255,0.8)]"
              style={{ color: "hsl(289 80% 55%)" }}
            >
              {handle}
            </p>
          </div>

          {/* Full-width info rows */}
          <div className="space-y-2.5 mb-2.5">
            {/* Status - NOT clickable */}
            <div className="rounded-2xl px-4 py-3.5 glass-stat-box flex items-center justify-between">
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
                Status
              </p>
              <div className="flex items-center gap-1.5">
                <span
                  className={`w-2 h-2 rounded-full ${statusDisplay.dotColor}`}
                />
                <p className={`text-sm font-bold ${statusDisplay.textColor}`}>
                  {statusDisplay.text}
                </p>
              </div>
            </div>

            {/* Model - only clickable when runtime is running */}
            <button
              type="button"
              onClick={() => {
                if (!isRuntimeRunning) {
                  onBlockedAction("model");
                  return;
                }
                setShowModel(true);
              }}
              aria-disabled={!isRuntimeRunning}
              className={`w-full rounded-2xl px-4 py-3.5 glass-stat-box flex items-center justify-between transition-colors ${
                isRuntimeRunning
                  ? "cursor-pointer hover:bg-white/50"
                  : "opacity-60 cursor-not-allowed"
              }`}
            >
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
                Model
              </p>
              <div className="flex items-center gap-1">
                <p className="text-sm font-bold text-foreground">{modelName}</p>
                <svg
                  className="w-3.5 h-3.5 text-muted-foreground"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 5l7 7-7 7"
                  />
                </svg>
              </div>
            </button>
          </div>

          {/* Info pills */}
          <div className="flex items-stretch gap-2 mb-5">
            {/* Repair - clickable */}
            <button
              type="button"
              onClick={() => setShowRepairConfirm(true)}
              disabled={runtimeBusy}
              className={`flex-1 rounded-2xl px-2 py-3.5 glass-stat-box text-center min-w-0 flex flex-col justify-center items-center transition-colors appearance-none border-0 ${
                runtimeBusy
                  ? "opacity-60 cursor-not-allowed"
                  : "cursor-pointer hover:bg-white/50"
              }`}
            >
              <p className="text-[9px] uppercase tracking-widest text-muted-foreground mb-1">Repair</p>
              <svg className="w-4 h-4 text-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
              </svg>
            </button>

            {/* Credits */}
            <div
              className="rounded-2xl px-3 py-3.5 glass-stat-box text-center min-w-0 flex flex-col justify-center"
              style={{ flex: "1.4" }}
            >
              <p className="text-[9px] uppercase tracking-widest text-muted-foreground mb-1">
                Credits
              </p>
              <p className={`font-bold text-foreground whitespace-nowrap ${credits ? "text-sm" : "text-[10px] text-muted-foreground animate-pulse"}`}>
                {creditsDisplay}
              </p>
            </div>

            {/* Skills - clickable */}
            <div
              onClick={() => setShowSkills(true)}
              className="flex-1 rounded-2xl px-2 py-3.5 glass-stat-box text-center min-w-0 flex flex-col justify-center cursor-pointer hover:bg-white/50 transition-colors"
            >
              <p className="text-[9px] uppercase tracking-widest text-muted-foreground mb-1">
                Skills
              </p>
              <p className="text-sm font-bold text-foreground">{skillsCount}</p>
            </div>
          </div>

          {/* Action buttons */}
          <div className="space-y-2.5">
            <button
              onClick={handleChat}
              aria-disabled={!isRuntimeRunning}
              className={`w-full flex items-center justify-center gap-2 rounded-2xl py-3.5 text-sm font-semibold btn-press shadow-lg ${
                isRuntimeRunning
                  ? "text-white bg-foreground"
                  : "text-white/80 bg-foreground/60 cursor-not-allowed"
              }`}
            >
              <svg
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                />
              </svg>
              Chat with PIN Claw
            </button>
            <button
              onClick={() => {
                const action = decideDataConnectorsAction(isRuntimeRunning);
                if (action === "blocked") {
                  onBlockedAction("data");
                  return;
                }
                setShowData(true);
              }}
              aria-disabled={!isRuntimeRunning}
              className={`w-full flex items-center justify-center gap-2 rounded-2xl py-3 text-sm font-medium btn-press glass-stat-box border-foreground/30 ${
                isRuntimeRunning
                  ? "text-foreground"
                  : "text-foreground/70 cursor-not-allowed opacity-60"
              }`}
            >
              <svg
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4"
                />
              </svg>
              Data Connectors
              <span className="text-xs text-muted-foreground ml-1">
                {googleConnectedCount}/5
              </span>
            </button>
            <button
              onClick={onOpenManage}
              className="w-full flex items-center justify-center gap-2 rounded-2xl py-3 text-sm font-medium text-foreground btn-press glass-stat-box border-foreground/30"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                />
              </svg>
              Manage
            </button>
          </div>
        </div>
      </div>

      <ManageAgentDialog
        open={manageOpen}
        onClose={onCloseManage}
        planId={planId}
        runtimeStatus={status}
        onChangePlan={onChangePlan}
        onRepairRuntime={onRepairRuntime}
        runtimeBusy={runtimeBusy}
        allowDeleteAccount={allowDeleteAccount}
        onDeleteAccount={onDeleteAccount}
      />

      <DataConnectionsDialog
        open={showData}
        onClose={() => setShowData(false)}
        google={google}
        googleBusy={googleBusy}
        onConnectGoogle={onConnectGoogle}
        onDisconnectGoogle={onDisconnectGoogle}
      />

      <SkillsDialog
        open={showSkills}
        onClose={() => setShowSkills(false)}
        skills={skills}
      />

      <ModelPickerDialog
        open={showModel}
        onClose={() => setShowModel(false)}
        models={models}
        modelBusy={modelBusy}
        onChangeModel={onChangeModel}
        onLoadModels={onLoadModels}
      />

      {showRepairConfirm && createPortal(
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4 animate-fade-in" onClick={() => setShowRepairConfirm(false)}>
          <div className="relative bg-background max-w-[340px] w-full rounded-3xl p-0 overflow-hidden shadow-lg" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => setShowRepairConfirm(false)}
              className="absolute right-3 top-3 w-7 h-7 flex items-center justify-center rounded-full bg-secondary/80 hover:bg-secondary text-foreground/60 hover:text-foreground transition-all z-10"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18" /><path d="m6 6 12 12" />
              </svg>
            </button>
            <div className="px-5 pt-5 pb-0">
              <h3 className="text-lg font-bold text-foreground">Restart Agent?</h3>
            </div>
            <div className="px-5 pb-5 pt-3">
              <p className="text-sm text-foreground/70 mb-5">
                This restarts the current runtime with the platform-managed configuration. Workspace data is kept.
              </p>
              <div className="flex gap-2.5">
                <button
                  onClick={() => setShowRepairConfirm(false)}
                  className="flex-1 px-4 py-2.5 bg-secondary text-foreground rounded-xl text-sm font-medium btn-press"
                >
                  Cancel
                </button>
                <button
                  onClick={() => { setShowRepairConfirm(false); onRepairRuntime(); }}
                  className="flex-1 px-4 py-2.5 bg-foreground text-background rounded-xl text-sm font-bold btn-press"
                >
                  Restart
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
};

export default AgentCard;
