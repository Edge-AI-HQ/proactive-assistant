import { useState } from "react";

interface ManageAgentDialogProps {
  open: boolean;
  onClose: () => void;
  planId: string | null;
  onChangePlan: () => void;
  onDeleteAccount: () => void;
}

const ManageAgentDialog = ({ open, onClose, planId, onChangePlan, onDeleteAccount }: ManageAgentDialogProps) => {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  if (!open) return null;

  const menuItems = [
    {
      icon: "💳",
      label: "Change Subscription",
      desc: `Current: ${planId || "None"}`,
      onClick: () => {
        onClose();
        onChangePlan();
      },
      destructive: false,
    },
    {
      icon: "🗑️",
      label: "Delete Account",
      desc: "Permanently remove all data",
      onClick: () => setShowDeleteConfirm(true),
      destructive: true,
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

  return (
    <div className="fixed inset-0 z-[9999] bg-black/70 flex items-center justify-center p-4 animate-fade-in">
      <div className="bg-white rounded-2xl p-0 max-w-sm w-full shadow-2xl animate-scale-in">
        <div className="p-5 pb-3">
          <h3 className="text-base font-bold text-foreground">Manage Agent</h3>
          <p className="text-xs text-muted-foreground mt-1">Configure your agent settings</p>
        </div>
        <div className="px-3 pb-4 space-y-1">
          {menuItems.map(({ icon, label, desc, onClick, destructive }) => (
            <button
              key={label}
              onClick={onClick}
              className={`w-full flex items-center gap-3 px-3 py-3 rounded-xl transition-colors text-left btn-press
                ${destructive ? "hover:bg-red-50" : "hover:bg-gray-50"}
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
              <svg className="w-4 h-4 text-muted-foreground shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          ))}
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
