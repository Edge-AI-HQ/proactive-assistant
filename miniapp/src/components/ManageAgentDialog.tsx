import { useState } from "react";

interface ManageAgentDialogProps {
  open: boolean;
  onClose: () => void;
  planId: string | null;
  onChangePlan: () => void;
  onDeleteAccount: () => void;
  google?: {
    connected: boolean;
    email: string | null;
  };
  googleBusy: boolean;
  onConnectGoogle: () => void;
  onDisconnectGoogle: () => void;
}

const ManageAgentDialog = ({
  open,
  onClose,
  planId,
  onChangePlan,
  onDeleteAccount,
  google,
  googleBusy,
  onConnectGoogle,
  onDisconnectGoogle,
}: ManageAgentDialogProps) => {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showGoogleDisconnectConfirm, setShowGoogleDisconnectConfirm] = useState(false);

  if (!open) return null;

  const googleLoading = !google;
  const googleConnected = google?.connected ?? false;

  const menuItems = [
    {
      icon: "📧",
      label: googleLoading ? "Google" : googleConnected ? "Disconnect Google" : "Connect Google",
      desc: googleLoading
        ? "Loading..."
        : googleConnected
          ? `Connected mailbox: ${google?.email || "Connected"}`
          : "Connect Gmail for email actions",
      onClick: () => {
        if (googleLoading || googleBusy) return;
        if (googleConnected) {
          setShowGoogleDisconnectConfirm(true);
          return;
        }
        onConnectGoogle();
      },
      destructive: false,
      loading: googleBusy || googleLoading,
    },
    {
      icon: "💳",
      label: "Change Subscription",
      desc: `Current: ${planId || "None"}`,
      onClick: () => {
        onClose();
        onChangePlan();
      },
      destructive: false,
      loading: false,
    },
    {
      icon: "🗑️",
      label: "Delete Account",
      desc: "Permanently remove all data",
      onClick: () => setShowDeleteConfirm(true),
      destructive: true,
      loading: false,
    },
  ];

  if (showDeleteConfirm) {
    return (
      <div className="fixed inset-0 z-[9999] bg-black/70 flex items-center justify-center p-4 animate-fade-in">
        <div className="bg-white rounded-2xl p-6 max-w-sm w-full shadow-2xl animate-scale-in">
          <h3 className="text-lg font-bold text-foreground mb-2">Delete Account?</h3>
          <p className="text-sm text-foreground/70 mb-6">
            This action cannot be undone. All assistant data, subscription, and history will be permanently removed.
          </p>
          <div className="flex gap-2.5">
            <button
              onClick={() => { setShowDeleteConfirm(false); onClose(); }}
              className="flex-1 px-4 py-2.5 bg-gray-100 text-gray-700 rounded-xl text-sm font-medium btn-press"
            >
              Cancel
            </button>
            <button
              onClick={() => { setShowDeleteConfirm(false); onClose(); onDeleteAccount(); }}
              className="flex-1 px-4 py-2.5 bg-red-500 text-white rounded-xl text-sm font-bold btn-press"
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (showGoogleDisconnectConfirm) {
    return (
      <div className="fixed inset-0 z-[9999] bg-black/70 flex items-center justify-center p-4 animate-fade-in">
        <div className="bg-white rounded-2xl p-6 max-w-sm w-full shadow-2xl animate-scale-in">
          <h3 className="text-lg font-bold text-foreground mb-2">Disconnect Google?</h3>
          <p className="text-sm text-foreground/70 mb-6">
            Your assistant will lose access to Gmail actions until you connect this mailbox again.
          </p>
          <div className="flex gap-2.5">
            <button
              onClick={() => setShowGoogleDisconnectConfirm(false)}
              className="flex-1 px-4 py-2.5 bg-gray-100 text-gray-700 rounded-xl text-sm font-medium btn-press"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                setShowGoogleDisconnectConfirm(false);
                onDisconnectGoogle();
              }}
              className="flex-1 px-4 py-2.5 bg-foreground text-white rounded-xl text-sm font-bold btn-press"
            >
              Disconnect
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[9999] bg-black/70 flex items-center justify-center p-4 animate-fade-in">
      <div className="bg-white rounded-2xl p-0 max-w-sm w-full shadow-2xl animate-scale-in">
        <div className="p-5 pb-3">
          <h3 className="text-base font-bold text-foreground">Manage Agent</h3>
          <p className="text-xs text-muted-foreground mt-1">Configure your agent settings</p>
        </div>
        <div className="px-3 pb-4 space-y-1">
          {menuItems.map(({ icon, label, desc, onClick, destructive, loading }) => (
            <button
              key={label}
              onClick={onClick}
              disabled={loading}
              className={`w-full flex items-center gap-3 px-3 py-3 rounded-xl transition-colors text-left btn-press
                ${destructive ? "hover:bg-red-50" : "hover:bg-gray-50"}
                ${loading ? "opacity-60 cursor-not-allowed" : ""}
              `}
            >
              <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 text-lg
                ${destructive ? "bg-red-50" : "bg-gray-100"}
              `}>
                {icon}
              </div>
              <div className="flex-1 min-w-0">
                <p className={`text-sm font-medium ${destructive ? "text-red-500" : "text-foreground"}`}>{label}</p>
                <p className="text-[11px] text-muted-foreground">{desc}</p>
              </div>
              {loading ? (
                <span className="text-[11px] text-muted-foreground shrink-0">Working...</span>
              ) : null}
              <svg className="w-4 h-4 text-muted-foreground shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          ))}
          {googleConnected ? (
            <div className="rounded-xl bg-gray-50 px-3 py-3 mt-2">
              <p className="text-[11px] font-semibold text-foreground">Use it in Telegram</p>
              <p className="text-[11px] text-muted-foreground mt-1">
                Try: "Show me my latest 10 emails" or "Summarize unread emails from today".
              </p>
            </div>
          ) : null}
        </div>
        <div className="p-4 border-t border-gray-100">
          <button
            onClick={onClose}
            className="w-full px-4 py-2.5 bg-gray-100 text-gray-600 rounded-xl text-sm font-medium btn-press"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default ManageAgentDialog;
