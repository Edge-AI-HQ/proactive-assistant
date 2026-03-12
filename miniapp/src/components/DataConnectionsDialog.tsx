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
  onClick?: () => void;
}

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
      onClick: () => {
        if (googleBusy) return;
        if (googleConnected) {
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
        className="relative bg-background max-w-sm w-full rounded-3xl p-0 overflow-hidden shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute right-4 top-4 rounded-sm opacity-70 hover:opacity-100 transition-opacity z-10"
        >
          <svg className="h-4 w-4 text-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        <div className="px-5 pt-5 pb-0">
          <h3 className="text-lg font-bold text-foreground">Data Connectors</h3>
          <p className="text-xs text-muted-foreground">Connect accounts to power your AI</p>
        </div>

        <div className="px-3 pb-4 pt-2 space-y-0.5">
          {connections.map((conn) => (
            <button
              key={conn.name}
              disabled={!conn.enabled || googleBusy}
              onClick={conn.onClick}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors text-left ${
                conn.enabled ? "hover:bg-accent" : "cursor-not-allowed"
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
                {conn.connected && conn.name === "Google" && google?.email && (
                  <p className="text-[10px] text-muted-foreground truncate">{google.email}</p>
                )}
                {!conn.enabled && (
                  <p className="text-[10px] text-muted-foreground/40">Coming Soon</p>
                )}
              </div>
              <span className={`text-xs font-semibold ${
                conn.connected
                  ? ""
                  : conn.enabled
                    ? "text-muted-foreground"
                    : "text-muted-foreground/30"
              }`} style={conn.connected ? { color: "hsl(152 69% 35%)" } : undefined}>
                {!conn.enabled
                  ? ""
                  : googleBusy && conn.name === "Google"
                    ? "Working..."
                    : conn.connected
                      ? "Connected"
                      : "Unconnected"}
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
