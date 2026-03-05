import { useEffect, useState } from "react";
import CreateAgentFlow from "./components/CreateAgentFlow";
import CreateAgentCTA from "./components/CreateAgentCTA";
import TopStatus from "./components/TopStatus";
import AgentCard from "./components/AgentCard";
import AgentSkills from "./components/AgentSkills";
import AgentInsights from "./components/AgentInsights";
import ChangePlanDialog from "./components/ChangePlanDialog";

type Plan = {
  id: string;
  name: string;
  price: string;
  description: string;
  features: string[];
  popular: boolean;
};

type SkillItem = {
  key: string;
  name: string;
  description: string;
  installed: boolean;
  enabled: boolean;
};

type StatePayload = {
  user: {
    telegram_user_id: number;
    telegram_username: string | null;
  };
  assistant: {
    exists: boolean;
    id?: number;
    username?: string | null;
    status?: string;
  };
  subscription: {
    active: boolean;
    status: string | null;
    plan_id: string | null;
    cancel_at_period_end: boolean;
    current_period_end: string | null;
  };
  plans: Plan[];
  skills: {
    supported: boolean;
    message: string;
    items: SkillItem[];
    config?: Record<string, unknown> | null;
  };
};

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        ready: () => void;
        expand: () => void;
        initData?: string;
        openTelegramLink?: (url: string) => void;
        initDataUnsafe?: {
          user?: {
            id: number;
            first_name?: string;
            last_name?: string;
            username?: string;
            language_code?: string;
          };
          auth_date?: number;
          hash?: string;
        };
      };
    };
  }
}

const safeFetch = async <T,>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
    ...init,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      (payload as { error?: string }).error || `HTTP ${response.status}`,
    );
  }

  return payload as T;
};

const App = () => {
  const [state, setState] = useState<StatePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedPlan, setSelectedPlan] = useState<string | null>(null);
  const [busy, setBusy] = useState<string>("none");
  const [showCreateFlow, setShowCreateFlow] = useState(false);
  const [hasSeenIntro, setHasSeenIntro] = useState(false);
  const [showChangePlan, setShowChangePlan] = useState(false);

  const hydrateState = (payload: StatePayload): void => {
    setState(payload);
    setSelectedPlan(
      (prev) => prev ?? payload.subscription.plan_id ?? payload.plans[0]?.id ?? null,
    );
  };

  const loadState = async () => {
    const payload = await safeFetch<StatePayload>("/api/mini/state");
    hydrateState(payload);
  };

  const bootstrap = async () => {
    const initData = window.Telegram?.WebApp?.initData?.trim() ?? "";
    const initDataUnsafe = window.Telegram?.WebApp?.initDataUnsafe;
    
    console.log('[MiniApp] Bootstrap Debug Info:', {
      hasInitData: !!initData,
      initDataLength: initData.length,
      telegram: !!window.Telegram,
      webApp: !!window.Telegram?.WebApp,
      hasInitDataUnsafe: !!initDataUnsafe,
      userId: initDataUnsafe?.user?.id,
      username: initDataUnsafe?.user?.username,
      userAgent: navigator.userAgent,
      url: window.location.href,
    });
    
    if (initData) {
      console.log('[MiniApp] ✓ Using Telegram initData for bootstrap');
      
      const requestBody = { init_data: initData };
      console.log('[MiniApp] Preparing bootstrap request:', {
        url: '/api/mini/bootstrap',
        method: 'POST',
        bodyKeys: Object.keys(requestBody),
        initDataLength: initData.length,
        initDataPreview: initData.substring(0, 50) + '...',
      });
      
      try {
        const payload = await safeFetch<StatePayload>("/api/mini/bootstrap", {
          method: "POST",
          body: JSON.stringify(requestBody),
        });
        
        console.log('[MiniApp] ✓ Bootstrap SUCCESS:', {
          hasAssistant: payload.assistant.exists,
          assistantId: payload.assistant.id,
          hasSubscription: payload.subscription.active,
          planId: payload.subscription.plan_id,
          subscriptionStatus: payload.subscription.status,
        });
        
        hydrateState(payload);
        return;
      } catch (error) {
        console.error('[MiniApp] ✗ Bootstrap FAILED:', error);
        throw error;
      }
    }

    console.warn('[MiniApp] ✗ No initData available');
    console.warn('Possible reasons:');
    console.warn('  1. Opened in regular browser instead of Telegram');
    console.warn('  2. Web Telegram does not have initData yet (still loading)');
    console.warn('  3. Mini App not opened via proper Telegram button/link');
    console.warn('');
    console.warn('Please ensure you:');
    console.warn('  - Open from Telegram bot menu button or inline button');
    console.warn('  - Use Telegram mobile/desktop app (recommended)');
    console.warn('  - Wait for Telegram WebApp SDK to fully load');
    
    // Try to load existing session (will fail with 401 if no session)
    console.log('[MiniApp] Attempting to use existing session cookie...');
    await loadState();
  };

  useEffect(() => {
    window.Telegram?.WebApp?.ready?.();
    window.Telegram?.WebApp?.expand?.();
    setLoading(true);
    setError(null);

    void bootstrap()
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "unknown error");
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  // No longer needed - we'll show CreateAgentFlow directly in the render
  // useEffect(() => {
  //   if (state && !loading && !hasSeenIntro && !state.assistant.exists) {
  //     console.log('[MiniApp] Auto-opening CreateAgentFlow for first-time user');
  //     setShowCreateFlow(true);
  //     setHasSeenIntro(true);
  //   }
  // }, [state, loading, hasSeenIntro]);

  const createAssistant = async () => {
    setBusy("create");
    try {
      await safeFetch("/api/mini/create-assistant", {
        method: "POST",
        body: JSON.stringify({}),
      });
      await loadState();
    } catch (e) {
      alert(`Create failed: ${e instanceof Error ? e.message : "unknown"}`);
    } finally {
      setBusy("none");
    }
  };

  const checkout = async () => {
    if (!selectedPlan) return;
    setBusy("checkout");
    try {
      const result = await safeFetch<{ url: string | null }>("/api/mini/checkout", {
        method: "POST",
        body: JSON.stringify({ plan: selectedPlan }),
      });
      if (!result.url) throw new Error("missing checkout url");
      window.location.href = result.url;
    } catch (e) {
      alert(
        `Unable to create checkout session: ${e instanceof Error ? e.message : "unknown"}`,
      );
      setBusy("none");
    }
  };

  const cancelSubscription = async () => {
    if (!window.confirm("Cancel renewal? Service remains active until period end.")) {
      return;
    }
    setBusy("cancel");
    try {
      await safeFetch("/api/mini/cancel-subscription", {
        method: "POST",
        body: JSON.stringify({}),
      });
      alert("Renewal canceled. Service remains active until period end.");
      await loadState();
    } catch (e) {
      alert(`Cancel failed: ${e instanceof Error ? e.message : "unknown"}`);
      setBusy("none");
    }
  };

  const handleDeleteAccount = async () => {
    setBusy("delete");
    try {
      const telegramUserId = state?.user.telegram_user_id;
      if (!telegramUserId) {
        throw new Error("User ID not found");
      }
      
      // Call reset account API
      await safeFetch(`/api/reset-account/${telegramUserId}`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      
      alert("Account deleted successfully. Redirecting...");
      window.location.reload();
    } catch (e) {
      alert(`Delete failed: ${e instanceof Error ? e.message : "unknown"}`);
      setBusy("none");
    }
  };

  const installSkill = async (skillKey: string) => {
    setBusy(`skill-install:${skillKey}`);
    try {
      await safeFetch("/api/mini/skills/install", {
        method: "POST",
        body: JSON.stringify({ skill_key: skillKey }),
      });
      await loadState();
    } catch (e) {
      alert(`Install failed: ${e instanceof Error ? e.message : "unknown"}`);
      setBusy("none");
    }
  };

  const uninstallSkill = async (skillKey: string) => {
    setBusy(`skill-uninstall:${skillKey}`);
    try {
      await safeFetch("/api/mini/skills/uninstall", {
        method: "POST",
        body: JSON.stringify({ skill_key: skillKey }),
      });
      await loadState();
    } catch (e) {
      alert(`Uninstall failed: ${e instanceof Error ? e.message : "unknown"}`);
      setBusy("none");
    }
  };

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-2xl p-5">
        <div className="panel p-9 text-center text-sm text-muted">
          Loading...
        </div>
      </div>
    );
  }

  // Debug: log current state
  if (state) {
    console.log('[MiniApp] Current state:', {
      hasAssistant: state.assistant.exists,
      hasSubscription: state.subscription.active,
      showCreateFlow,
      hasSeenIntro,
    });
  }

  if (error || !state) {
    const isAuthError = error?.includes("401") || error?.includes("Unauthorized");
    return (
      <div className="min-h-screen bg-pin-gradient flex items-center justify-center p-5">
        <div className="glass-card rounded-2xl p-6 max-w-md text-center">
          <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-destructive" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <h2 className="text-lg font-bold text-foreground mb-2">
            {isAuthError ? "Authentication Required" : "Load Failed"}
          </h2>
          <p className="text-sm text-foreground/70 mb-4">
            {isAuthError 
              ? "Please open this page in Telegram app" 
              : error || "Unknown error"}
          </p>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-foreground text-background rounded-xl text-sm font-medium btn-press"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }

  // Show CreateAgentFlow directly when no assistant exists
  if (!state.assistant.exists) {
    return (
      <CreateAgentFlow 
        open={true} 
        onClose={() => {}} // No close button for first-time users
        onCreateSuccess={() => void loadState()}
      />
    );
  }

  // Show subscription required page when assistant exists but no subscription
  if (!state.subscription.active) {
    return (
      <div className="min-h-screen bg-pin-gradient max-w-md mx-auto p-4 pb-8">
        <section className="glass-card rounded-2xl p-6 mt-4 animate-fade-in">
          <span className="pill bg-foreground text-background">PIN AI MINI</span>
          <h1 className="mt-4 font-heading text-2xl font-bold leading-[1.1] text-foreground">
            Subscription Required
          </h1>
          <p className="mt-2 max-w-md text-sm text-foreground/70">
            Subscribe first to unlock runtime controls and skills management.
          </p>
        </section>

        <section className="glass-card rounded-2xl p-5 mt-3 animate-fade-in">
          <div className="mb-4">
            <h2 className="text-lg font-semibold text-foreground">Choose Plan</h2>
          </div>
          <div className="space-y-2.5">
            {state.plans.map((plan) => {
              const selected = selectedPlan === plan.id;
              return (
                <button
                  key={plan.id}
                  className={`w-full rounded-xl p-4 text-left transition-all btn-press ${
                    selected 
                      ? "bg-white/60 border-2 border-primary shadow-lg" 
                      : "bg-white/30 border border-white/40 hover:bg-white/40"
                  }`}
                  onClick={() => setSelectedPlan(plan.id)}
                >
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="text-base font-bold text-foreground">{plan.name}</span>
                    <span className="text-lg font-extrabold text-primary">
                      ${plan.price}<span className="text-sm font-normal text-muted-foreground">/mo</span>
                    </span>
                  </div>
                  <div className="text-xs text-foreground/60">
                    {plan.features.slice(0, 2).join(" · ")}
                  </div>
                </button>
              );
            })}
          </div>
          <div className="mt-4 space-y-2.5">
            <button
              className="w-full rounded-xl bg-foreground text-background px-4 py-3.5 text-sm font-bold shadow-lg btn-press disabled:opacity-50"
              onClick={() => void checkout()}
              disabled={busy !== "none" || !selectedPlan}
            >
              {busy === "checkout" ? "Redirecting..." : "Continue to Checkout"}
            </button>
            <button
              className="w-full rounded-xl bg-secondary/60 text-foreground px-4 py-3 text-sm font-medium btn-press"
              onClick={() => void loadState()}
            >
              Refresh
            </button>
          </div>
        </section>
        <div className="mt-4 text-center text-xs text-foreground/50">PIN AI</div>
      </div>
    );
  }

  // Show home page with agent when subscription is active
  if (state.assistant.exists) {
    return (
      <div className="min-h-screen bg-pin-gradient max-w-md mx-auto pb-8">
        <TopStatus hasAgent={true} />

        <div className="px-4 mt-6 space-y-4">
          <h2 className="text-base font-semibold text-foreground px-1">
            <span className="title-highlight">My Agent</span>
          </h2>
          <AgentCard
            username={state.assistant.username || null}
            status={state.assistant.status || "unknown"}
            planId={state.subscription.plan_id}
            active={state.subscription.active}
            onChangePlan={() => setShowChangePlan(true)}
            onDeleteAccount={handleDeleteAccount}
          />
        </div>

        {state.skills.supported && state.skills.items.length > 0 && (
          <div className="px-4 mt-6">
            <AgentSkills
              skills={state.skills.items}
              onInstall={installSkill}
              onUninstall={uninstallSkill}
              busy={busy}
            />
          </div>
        )}

        <div className="px-4 mt-6">
          <AgentInsights />
        </div>

        <div className="px-4 mt-8 mb-4">
          <a
            href="mailto:support@pinai.io"
            className="glass-card rounded-2xl flex items-center justify-center gap-2 text-sm text-foreground font-medium py-3.5 hover:bg-secondary/50 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
            Contact Us
          </a>
        </div>

        <ChangePlanDialog
          open={showChangePlan}
          onClose={() => setShowChangePlan(false)}
          plans={state.plans}
          currentPlanId={state.subscription.plan_id}
          selectedPlan={selectedPlan}
          onSelectPlan={setSelectedPlan}
          onCheckout={checkout}
          onCancel={cancelSubscription}
          busy={busy}
        />
      </div>
    );
  }

  // Show subscription center when subscription is active but no assistant
  return (
    <div className="min-h-screen bg-pin-gradient max-w-md mx-auto p-4 pb-8">
      <section className="glass-card rounded-2xl p-6 mt-4 animate-fade-in">
        <span className="pill bg-foreground text-background">PIN AI</span>
        <h1 className="mt-4 font-heading text-2xl font-bold leading-[1.1] text-foreground">
          Subscription Center
        </h1>
        <p className="mt-2 max-w-md text-sm text-foreground/70">
          Your subscription is active. Create your assistant to get started.
        </p>
      </section>

      <section className="glass-card rounded-2xl p-5 mt-3 animate-fade-in">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-foreground">Runtime Status</h2>
          <span
            className={`pill text-xs ${state.subscription.active ? "bg-pin-mint/20 text-pin-mint-text" : "bg-amber-100 text-amber-700"}`}
          >
            {state.subscription.active ? "Active" : "Inactive"}
          </span>
        </div>
        <div className="space-y-2">
          <div className="text-sm text-foreground/80">
            <span className="font-medium">Status:</span> {state.assistant.exists ? (state.assistant.status || "unknown") : "assistant not created"}
          </div>
          <div className="text-sm text-foreground/80">
            <span className="font-medium">Current plan:</span> {state.subscription.plan_id || "none"}
          </div>
          {state.subscription.current_period_end ? (
            <div className="text-sm text-foreground/80">
              <span className="font-medium">Period end:</span> {state.subscription.current_period_end}
            </div>
          ) : null}
          {state.subscription.cancel_at_period_end ? (
            <div className="text-sm text-amber-600 font-medium mt-2">
              ⚠️ Renewal canceled (service ends at period end)
            </div>
          ) : null}
        </div>
      </section>

      {!state.assistant.exists ? (
        <section className="glass-card rounded-2xl p-5 mt-3 animate-fade-in">
          <h2 className="text-lg font-semibold text-foreground mb-3">Create Assistant</h2>
          <p className="text-sm text-foreground/70 mb-4">
            Subscription is active. Create your assistant to enable runtime and skills.
          </p>
          <button
            className="w-full rounded-xl bg-foreground text-background px-4 py-3.5 text-sm font-bold shadow-lg btn-press disabled:opacity-50"
            onClick={() => void createAssistant()}
            disabled={busy !== "none"}
          >
            {busy === "create" ? "Creating..." : "Create Assistant"}
          </button>
        </section>
      ) : null}

      <section className="glass-card rounded-2xl p-5 mt-3 animate-fade-in">
        <div className="mb-4 flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-foreground">Change Plan</h2>
          <span className="pill text-xs bg-secondary/60 text-foreground">Flexible</span>
        </div>

        <div className="space-y-2.5">
          {state.plans.map((plan) => {
            const selected = selectedPlan === plan.id;
            const current = state.subscription.plan_id === plan.id;
            return (
              <button
                key={plan.id}
                className={`w-full rounded-xl p-4 text-left transition-all btn-press ${
                  selected 
                    ? "bg-white/60 border-2 border-primary shadow-lg" 
                    : "bg-white/30 border border-white/40 hover:bg-white/40"
                }`}
                onClick={() => setSelectedPlan(plan.id)}
              >
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className="flex items-center gap-2">
                    <span className="text-base font-bold text-foreground">{plan.name}</span>
                    {current && <span className="text-xs px-2 py-0.5 rounded-full bg-pin-mint/20 text-pin-mint-text font-medium">Current</span>}
                  </div>
                  <span className="text-lg font-extrabold text-primary">
                    ${plan.price}<span className="text-sm font-normal text-muted-foreground">/mo</span>
                  </span>
                </div>
                <div className="text-xs text-foreground/60">
                  {plan.features.slice(0, 2).join(" · ")}
                </div>
              </button>
            );
          })}
        </div>

        <div className="mt-4 space-y-2.5">
          <button
            className="w-full rounded-xl bg-foreground text-background px-4 py-3.5 text-sm font-bold shadow-lg btn-press disabled:opacity-50"
            onClick={() => void checkout()}
            disabled={busy !== "none" || !selectedPlan}
          >
            {busy === "checkout" ? "Redirecting..." : "Continue to Checkout"}
          </button>
          <button
            className="w-full rounded-xl bg-secondary/60 text-foreground px-4 py-3 text-sm font-medium btn-press disabled:opacity-50"
            onClick={() => void cancelSubscription()}
            disabled={busy !== "none"}
          >
            {busy === "cancel" ? "Processing..." : "Cancel Renewal"}
          </button>
        </div>
      </section>

      <section className="glass-card rounded-2xl p-5 mt-3 animate-fade-in">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-foreground">Skills</h2>
          <span className={`pill text-xs ${state.skills.supported ? "bg-pin-mint/20 text-pin-mint-text" : "bg-amber-100 text-amber-700"}`}>
            {state.skills.supported ? "Enabled" : "Pending"}
          </span>
        </div>
        <div className="text-sm text-foreground/70 mb-4">{state.skills.message}</div>
        {state.skills.supported ? (
          <div className="space-y-2.5">
            {(state.skills.items || []).map((skill) => {
              const installing = busy === `skill-install:${skill.key}`;
              const uninstalling = busy === `skill-uninstall:${skill.key}`;
              return (
                <div
                  key={skill.key}
                  className="rounded-xl bg-white/30 border border-white/40 p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1">
                      <div className="text-sm font-bold text-foreground">{skill.name}</div>
                      <div className="mt-1 text-xs text-foreground/70">
                        {skill.description}
                      </div>
                      <div className="mt-1.5 text-[11px] text-foreground/50">
                        {skill.key} · {skill.installed ? (
                          <span className="text-pin-mint-text">✓ installed</span>
                        ) : (
                          <span>not installed</span>
                        )}
                      </div>
                    </div>
                    {skill.enabled ? (
                      <button
                        className="rounded-lg bg-secondary/60 px-3 py-2 text-xs font-semibold text-foreground btn-press disabled:opacity-50 shrink-0"
                        onClick={() => void uninstallSkill(skill.key)}
                        disabled={busy !== "none"}
                      >
                        {uninstalling ? "Removing..." : "Remove"}
                      </button>
                    ) : (
                      <button
                        className="rounded-lg bg-foreground text-background px-3 py-2 text-xs font-semibold btn-press disabled:opacity-50 shrink-0"
                        onClick={() => void installSkill(skill.key)}
                        disabled={busy !== "none"}
                      >
                        {installing ? "Installing..." : "Install"}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
      </section>

      <div className="mt-4 text-center text-xs text-foreground/50">PIN AI</div>
    </div>
  );
};

export default App;
