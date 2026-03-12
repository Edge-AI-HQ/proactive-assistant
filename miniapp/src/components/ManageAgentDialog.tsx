import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import useBodyScrollLock from "./useBodyScrollLock";

type ModelItem = {
  id: string;
  ref: string;
};

interface ManageAgentDialogProps {
  open: boolean;
  onClose: () => void;
  planId: string | null;
  runtimeStatus?: string;
  onChangePlan: () => void;
  onRepairRuntime: () => void;
  runtimeBusy: boolean;
  allowDeleteAccount: boolean;
  onDeleteAccount: () => void;
  models?: {
    current: string | null;
    available: ModelItem[];
  } | null;
  modelBusy: boolean;
  onChangeModel: (modelRef: string) => void;
  onLoadModels: () => Promise<void>;
  onOpenModelPicker: () => void;
}

const IconBrain = () => (
  <svg className="w-4 h-4 text-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
    <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
    <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
    <path d="M17.599 6.5a3 3 0 0 0 .399-1.375" />
    <path d="M6.003 5.125A3 3 0 0 0 6.401 6.5" />
    <path d="M3.477 10.896a4 4 0 0 1 .585-.396" />
    <path d="M19.938 10.5a4 4 0 0 1 .585.396" />
    <path d="M6 18a4 4 0 0 1-1.967-.516" />
    <path d="M19.967 17.484A4 4 0 0 1 18 18" />
  </svg>
);

const IconWrench = () => (
  <svg className="w-4 h-4 text-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  </svg>
);

const IconCreditCard = () => (
  <svg className="w-4 h-4 text-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <rect x="1" y="4" width="22" height="16" rx="2" /><path d="M1 10h22" />
  </svg>
);

const IconTrash = () => (
  <svg className="w-4 h-4 text-destructive" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
  </svg>
);

const IconChevron = () => (
  <svg className="w-4 h-4 text-muted-foreground shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 5l7 7-7 7" />
  </svg>
);

const ManageAgentDialog = ({
  open,
  onClose,
  planId,
  runtimeStatus,
  onChangePlan,
  onRepairRuntime,
  runtimeBusy,
  allowDeleteAccount,
  onDeleteAccount,
  onOpenModelPicker,
}: ManageAgentDialogProps) => {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showRepairConfirm, setShowRepairConfirm] = useState(false);

  useEffect(() => {
    if (!open) {
      setShowDeleteConfirm(false);
      setShowRepairConfirm(false);
    }
  }, [open]);

  useBodyScrollLock(open);

  if (!open) return null;

  if (showDeleteConfirm) {
    return createPortal(
      <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4 animate-fade-in">
        <div className="bg-background rounded-2xl p-6 max-w-sm w-full shadow-lg animate-scale-in">
          <h3 className="text-lg font-bold text-foreground mb-2">Delete Account?</h3>
          <p className="text-sm text-foreground/70 mb-6">
            This action cannot be undone. All agent data, history, and earned rewards will be permanently removed.
          </p>
          <div className="flex gap-2.5">
            <button
              onClick={() => { setShowDeleteConfirm(false); onClose(); }}
              className="flex-1 px-4 py-2.5 bg-secondary text-foreground rounded-xl text-sm font-medium btn-press"
            >
              Cancel
            </button>
            <button
              onClick={() => { setShowDeleteConfirm(false); onClose(); onDeleteAccount(); }}
              className="flex-1 px-4 py-2.5 bg-destructive text-destructive-foreground rounded-xl text-sm font-bold btn-press hover:bg-destructive/90"
            >
              Delete
            </button>
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  if (showRepairConfirm) {
    return createPortal(
      <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4 animate-fade-in">
        <div className="bg-background rounded-2xl p-6 max-w-sm w-full shadow-lg animate-scale-in">
          <h3 className="text-lg font-bold text-foreground mb-2">Restart?</h3>
          <p className="text-sm text-foreground/70 mb-6">
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
              onClick={() => { setShowRepairConfirm(false); onClose(); onRepairRuntime(); }}
              className="flex-1 px-4 py-2.5 bg-foreground text-background rounded-xl text-sm font-bold btn-press"
            >
              Restart
            </button>
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  const sections: { title: string; items: { icon: () => JSX.Element; label: string; desc: string; onClick: () => void; loading?: boolean }[] }[] = [
    {
      title: "AI Settings",
      items: [
        {
          icon: IconBrain,
          label: "Change Model",
          desc: "Switch AI model provider",
          onClick: () => onOpenModelPicker(),
        },
        {
          icon: IconWrench,
          label: "Repair Agent",
          desc: runtimeStatus ? `Status: ${runtimeStatus}` : "Diagnose and fix issues",
          onClick: () => setShowRepairConfirm(true),
          loading: runtimeBusy,
        },
      ],
    },
    {
      title: "Plan & Billing",
      items: [
        {
          icon: IconCreditCard,
          label: "Change Subscription",
          desc: `Current: ${planId ? planId.charAt(0).toUpperCase() + planId.slice(1) : "None"}`,
          onClick: () => { onClose(); onChangePlan(); },
        },
      ],
    },
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
          <h3 className="text-lg font-bold text-foreground">Manage Agent</h3>
          <p className="text-xs text-muted-foreground">Configure your agent settings</p>
        </div>

        <div className="px-3 pb-4 pt-2 space-y-4">
          {sections.map((section) => (
            <div key={section.title}>
              <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider px-3 mb-1">{section.title}</p>
              <div className="space-y-0.5">
                {section.items.map(({ icon: Icon, label, desc, onClick, loading }) => (
                  <button
                    key={label}
                    onClick={onClick}
                    disabled={loading}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors text-left hover:bg-accent ${loading ? "opacity-60 cursor-not-allowed" : ""}`}
                  >
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-secondary">
                      <Icon />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground">{label}</p>
                      <p className="text-[11px] text-muted-foreground">{desc}</p>
                    </div>
                    {loading ? (
                      <span className="text-[11px] text-muted-foreground shrink-0">Working...</span>
                    ) : (
                      <IconChevron />
                    )}
                  </button>
                ))}
              </div>
            </div>
          ))}

          {allowDeleteAccount && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider px-3 mb-1 text-destructive">Danger Zone</p>
              <button
                onClick={() => setShowDeleteConfirm(true)}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors text-left hover:bg-destructive/10"
              >
                <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-destructive/10">
                  <IconTrash />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-destructive">Delete Account</p>
                  <p className="text-[11px] text-muted-foreground">Permanently remove this agent</p>
                </div>
                <IconChevron />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default ManageAgentDialog;
