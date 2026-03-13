import { createPortal } from "react-dom";
import useBodyScrollLock from "./useBodyScrollLock";

interface DataConnectionsDialogProps {
  open: boolean;
  onClose: () => void;
  google?: { connected: boolean; email: string | null };
  googleBusy: boolean;
  onConnectGoogle: () => void;
  onDisconnectGoogle: () => void;
}

interface Connection {
  name: string;
  connected: boolean;
  enabled: boolean;
  description?: string;
  onClick?: () => void;
}

export const shouldDisconnectAfterConfirm = ({
  connected,
  busy,
  confirmDisconnect,
}: {
  connected: boolean;
  busy: boolean;
  confirmDisconnect: () => boolean;
}): boolean => {
  if (!connected || busy) return false;
  return confirmDisconnect();
};

const DataConnectionsDialog = ({
  open,
  onClose,
  google,
  googleBusy,
  onConnectGoogle,
  onDisconnectGoogle,
}: DataConnectionsDialogProps) => {
  useBodyScrollLock(open);
  if (!open) return null;

  const googleConnected = google?.connected ?? false;

  const connections: Connection[] = [
    {
      name: "Google",
      connected: googleConnected,
      enabled: true,
      description: googleConnected
        ? (google?.email || "Google Workspace connected")
        : "Connect Gmail, Calendar, and Drive",
      onClick: () => {
        if (googleBusy) return;
        if (googleConnected) {
          if (
            !shouldDisconnectAfterConfirm({
              connected: true,
              busy: googleBusy,
              confirmDisconnect: () =>
                window.confirm(
                  "Disconnect Google? Gmail, Calendar, and Drive access will be removed.",
                ),
            })
          ) {
            return;
          }
          onDisconnectGoogle();
        } else {
          onConnectGoogle();
        }
      },
    },
    { name: "Twitter", connected: false, enabled: false },
    { name: "Telegram", connected: false, enabled: false },
    { name: "Slack", connected: false, enabled: false },
    { name: "Notion", connected: false, enabled: false },
  ];

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4 animate-fade-in" onClick={onClose}>
      <div
        className="relative bg-background max-w-[340px] w-full rounded-3xl p-0 overflow-hidden shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute right-3 top-3 w-7 h-7 flex items-center justify-center rounded-full bg-secondary/80 hover:bg-secondary text-foreground/60 hover:text-foreground transition-all z-10"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6 6 18" /><path d="m6 6 12 12" />
          </svg>
        </button>

        <div className="px-5 pt-5 pb-0">
          <h3 className="text-lg font-bold text-foreground">Data Connectors</h3>
          <p className="text-xs text-muted-foreground">Connect accounts to power your AI</p>
        </div>

        <div className="px-3 pb-4 pt-2 space-y-1">
          {connections.map((conn) => (
            <button
              key={conn.name}
              disabled={!conn.enabled || googleBusy}
              onClick={conn.onClick}
              className={`w-full flex items-center gap-3 px-3 py-3 rounded-2xl transition-colors text-left ${
                conn.enabled ? "hover:bg-accent" : "cursor-not-allowed opacity-70"
              } ${googleBusy && conn.name === "Google" ? "opacity-60" : ""}`}
            >
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                conn.connected
                  ? "bg-[hsl(152_69%_65%/0.15)]"
                  : conn.enabled
                    ? "bg-secondary"
                    : "bg-secondary/50"
              }`}>
                {conn.connected ? (
                  <svg className="w-4 h-4" style={{ color: "hsl(152 69% 35%)" }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <svg className={`w-4 h-4 ${conn.enabled ? "text-muted-foreground" : "text-muted-foreground/40"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className={`text-sm font-medium ${conn.enabled ? "text-foreground" : "text-muted-foreground/50"}`}>{conn.name}</p>
                {conn.description && conn.enabled && (
                  <p className="text-[11px] text-muted-foreground truncate">{conn.description}</p>
                )}
                {!conn.enabled && (
                  <p className="text-[10px] text-muted-foreground/40">Coming Soon</p>
                )}
              </div>
              <span className={`text-[11px] font-semibold px-2 py-1 rounded-full ${
                conn.connected
                  ? "bg-[hsl(152_69%_65%/0.15)]"
                  : conn.enabled
                    ? "bg-secondary text-muted-foreground"
                    : "text-muted-foreground/30"
              }`} style={conn.connected ? { color: "hsl(152 69% 35%)" } : undefined}>
                {!conn.enabled
                  ? ""
                  : googleBusy && conn.name === "Google"
                    ? "Syncing..."
                    : conn.connected
                      ? "Connected"
                      : "Tap to Connect"}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default DataConnectionsDialog;
