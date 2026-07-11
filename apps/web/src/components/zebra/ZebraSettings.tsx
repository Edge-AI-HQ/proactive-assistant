import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle, Bell, ChevronRight, CreditCard, LogOut, Smartphone,
  SlidersHorizontal, Trash2,
} from "lucide-react";
import { deleteAccount, DeleteAccountError } from "@pin-ai/core";
import {
  AutoEvolutionSettings,
  AutoGenerateSettings,
  GenerationLanguageSettings,
  ScheduledTasksSettings,
  SubPageHeader,
  SubscriptionPanel,
  useAuth, Text,
} from "@/ui-web";
import { toast } from "sonner";

/**
 * Desktop (zebra) SETTING 四件 —— production AccountPanel 的桌面装配：
 * 主页 = 设置入口列表 + 账户区（Sign out / Delete account），子路由 =
 * Subscription（真实 Stripe 链路 SubscriptionPanel）/ Notifications（web
 * 端 push 由手机管理，如实呈现）/ Preferences（下沉的 settings sections
 * 堆叠）。ambient 采集控制 / 声纹是 native 专属，不进 web。
 */

function SettingsColumn({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full w-full max-w-2xl mx-auto overflow-y-auto px-4 pb-10" style={{ paddingTop: "var(--constellation-header-top, 2.5rem)" }}>
      {children}
    </div>
  );
}

export function ZebraSetting() {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const displayName =
    (user?.user_metadata?.full_name as string | undefined) ||
    user?.email?.split("@")[0] ||
    "there";

  const handleDeleteAccount = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await deleteAccount();
      await signOut();
    } catch (err) {
      const msg =
        err instanceof DeleteAccountError
          ? err.message
          : "Couldn't delete the account — try again.";
      toast.error(msg);
      setDeleting(false);
      setConfirmingDelete(false);
    }
  };

  const rows = [
    {
      icon: CreditCard,
      title: "Subscription & Billing",
      subtitle: "Plan, payment methods, invoices",
      to: "/subscription",
    },
    {
      icon: Bell,
      title: "Notifications",
      subtitle: "Delivered to your phone",
      to: "/notifications",
    },
    {
      icon: SlidersHorizontal,
      title: "Preferences",
      subtitle: "Generation, language, scheduled tasks",
      to: "/preferences",
    },
  ];

  return (
    <SettingsColumn>
      <h1 className="text-display text-2xl text-foreground mb-1">Setting</h1>
      <p className="text-xs text-muted-foreground mb-5">Subscription · Preferences · Notifications</p>

      {/* Account card */}
      <div className="glass-card-strong px-4 py-3.5 mb-4 flex items-center gap-3">
        <div
          className="w-10 h-10 rounded-2xl text-white text-body font-semibold flex items-center justify-center shrink-0"
          style={{ background: "linear-gradient(135deg, hsl(var(--primary)) 0%, hsl(330 80% 65%) 100%)" }}
        >
          {displayName.charAt(0).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <Text variant="bodySm" weight="semibold" className="block text-foreground truncate">{displayName}</Text>
          <Text variant="label" className="block text-foreground/45 truncate">{user?.email}</Text>
        </div>
        <button
          onClick={() => void signOut()}
          className="inline-flex items-center gap-1.5 rounded-xl border border-foreground/10 bg-white/60 px-3 py-2 text-label font-medium text-foreground/70 hover:bg-white/80 transition-colors shrink-0"
        >
          <LogOut size={13} strokeWidth={1.8} /> Sign out
        </button>
      </div>

      {/* Settings rows */}
      <div className="flex flex-col gap-2 mb-6">
        {rows.map((row) => (
          <button
            key={row.to}
            onClick={() => navigate(row.to)}
            className="glass-card px-4 py-3.5 flex items-center gap-3 text-left hover:bg-white/55 transition-colors"
          >
            <span className="w-9 h-9 rounded-xl bg-foreground/[0.05] flex items-center justify-center shrink-0">
              <row.icon size={16} strokeWidth={1.8} className="text-foreground/65" />
            </span>
            <span className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-foreground">{row.title}</p>
              <Text variant="label" className="block text-foreground/45 truncate">{row.subtitle}</Text>
            </span>
            <ChevronRight size={15} className="text-foreground/30 shrink-0" />
          </button>
        ))}
      </div>

      {/* Danger zone */}
      <div className="rounded-2xl border border-rose-500/15 bg-rose-500/[0.03] px-4 py-3.5">
        {confirmingDelete ? (
          <div>
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle size={14} className="text-rose-500" />
              <Text variant="bodySm" weight="semibold" className="block text-rose-600">
                Delete account permanently?
              </Text>
            </div>
            <Text variant="label" className="block text-foreground/55 leading-relaxed mb-3">
              All your data — cards, conversations, memory, connections — will be removed. This cannot be undone.
            </Text>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setConfirmingDelete(false)}
                disabled={deleting}
                className="px-3.5 py-2 rounded-xl bg-foreground/5 hover:bg-foreground/10 transition-colors text-label font-medium text-foreground/60"
              >
                Keep my account
              </button>
              <button
                onClick={() => void handleDeleteAccount()}
                disabled={deleting}
                className="px-3.5 py-2 rounded-xl bg-rose-600 text-white text-label font-semibold hover:bg-rose-700 transition-colors disabled:opacity-60"
              >
                {deleting ? "Deleting…" : "Delete everything"}
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setConfirmingDelete(true)}
            className="flex items-center gap-2 text-label font-medium text-rose-500/80 hover:text-rose-600 transition-colors"
          >
            <Trash2 size={13} strokeWidth={1.8} /> Delete account
          </button>
        )}
      </div>
    </SettingsColumn>
  );
}

export function ZebraSubscription() {
  const navigate = useNavigate();
  return (
    <SettingsColumn>
      <SubscriptionPanel onBack={() => navigate("/setting")} />
    </SettingsColumn>
  );
}

export function ZebraNotifications() {
  const navigate = useNavigate();
  return (
    <SettingsColumn>
      <SubPageHeader
        title="Notifications"
        subtitle="Where PIN AI reaches you"
        onBack={() => navigate("/setting")}
      />
      <div className="glass-card px-4 py-4 flex items-start gap-3">
        <span className="w-9 h-9 rounded-xl bg-foreground/[0.05] flex items-center justify-center shrink-0">
          <Smartphone size={16} strokeWidth={1.8} className="text-foreground/65" />
        </span>
        <div>
          <Text variant="bodySm" weight="semibold" className="block text-foreground mb-1">
            Push notifications live on your phone
          </Text>
          <Text variant="bodySm" className="block text-foreground/55 leading-relaxed">
            Card completions and proactive nudges are delivered through the PIN AI
            mobile app. Manage them in Setting → Notifications on your phone.
          </Text>
        </div>
      </div>
    </SettingsColumn>
  );
}

export function ZebraPreferences() {
  const navigate = useNavigate();
  return (
    <SettingsColumn>
      <SubPageHeader
        title="Preferences"
        subtitle="Generation · Language · Scheduled"
        onBack={() => navigate("/setting")}
      />
      <div className="flex flex-col gap-4">
        <AutoGenerateSettings />
        <GenerationLanguageSettings />
        <ScheduledTasksSettings />
        <AutoEvolutionSettings />
      </div>
    </SettingsColumn>
  );
}
