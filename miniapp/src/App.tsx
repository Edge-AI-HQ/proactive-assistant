import { useEffect, useState } from "react";
import CreateAgentFlow from "./components/CreateAgentFlow";
import TopStatus from "./components/TopStatus";
import AgentCard from "./components/AgentCard";
import ChangePlanDialog from "./components/ChangePlanDialog";
import VideoLanding from "./components/VideoLanding";
import SetupWaiting from "./components/SetupWaiting";
import Toast from "./components/Toast";

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
        requestFullscreen: () => void;
        platform?: string;
        close: () => void;
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
  const [showChangePlan, setShowChangePlan] = useState(false);
  const [showLanding, setShowLanding] = useState(
    () => !sessionStorage.getItem("landing_seen"),
  );
  const [showOnboarding, setShowOnboarding] = useState(
    () => !sessionStorage.getItem("onboarding_seen"),
  );
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);

  const showToast = (message: string, type: "success" | "error" = "error") => {
    setToast({ message, type });
  };

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
    const platform = window.Telegram?.WebApp?.platform;
    if (platform === 'ios' || platform === 'android') {
      window.Telegram?.WebApp?.requestFullscreen?.();
      // Telegram fullscreen adds close/settings buttons (~56px) below the safe area
      document.documentElement.style.setProperty("--tg-top-offset", "56px");
    }
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

  const createAssistant = async () => {
    setBusy("create");
    try {
      await safeFetch("/api/mini/create-assistant", {
        method: "POST",
        body: JSON.stringify({}),
      });
      await loadState();
    } catch (e) {
      showToast(`Create failed: ${e instanceof Error ? e.message : "unknown"}`);
    } finally {
      setBusy("none");
    }
  };

  const checkout = async () => {
    if (!selectedPlan) return;
    setBusy("checkout");
    try {
      const result = await safeFetch<{ url: string | null; action?: string; message?: string }>("/api/mini/checkout", {
        method: "POST",
        body: JSON.stringify({ plan: selectedPlan }),
      });
      if (result.action === "upgrade" || result.action === "downgrade") {
        // Plan changed directly via Stripe subscription update — no redirect needed
        showToast(result.message ?? "Plan updated successfully.", "success");
        setBusy("none");
        await loadState();
        return;
      }
      if (!result.url) throw new Error("Unable to get checkout URL. Please try again.");
      window.location.href = result.url;
    } catch (e) {
      showToast(`Unable to change plan: ${e instanceof Error ? e.message : "unknown"}`);
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
      showToast("Renewal canceled. Service remains active until period end.", "success");
      await loadState();
    } catch (e) {
      showToast(`Cancel failed: ${e instanceof Error ? e.message : "unknown"}`);
      setBusy("none");
    }
  };

  const handleDeleteAccount = async () => {
    setBusy("delete");
    try {
      await safeFetch("/api/mini/reset-account", {
        method: "POST",
        body: JSON.stringify({}),
      });
      showToast("Account deleted successfully.", "success");
      setTimeout(() => window.location.reload(), 1500);
    } catch (e) {
      showToast(`Delete failed: ${e instanceof Error ? e.message : "unknown"}`);
      setBusy("none");
    }
  };

  if (loading) {
    return (
      <div
        className="min-h-dvh bg-pin-gradient flex items-center justify-center p-5"
        style={{ paddingTop: "calc(var(--safe-top) + 1.25rem)" }}
      >
        <div className="glass-card rounded-2xl p-9 text-center text-sm text-muted-foreground max-w-md w-full">
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
    });
  }

  if (error || !state) {
    const isAuthError = error?.includes("401") || error?.includes("Unauthorized");
    return (
      <div
        className="min-h-dvh bg-pin-gradient flex items-center justify-center p-5"
        style={{ paddingTop: "calc(var(--safe-top) + 1.25rem)" }}
      >
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

  // Onboarding flow for unpaid users: Landing → Features → Choose Plan
  if (!state.subscription.active && showLanding) {
    return <VideoLanding onGetStarted={() => { sessionStorage.setItem("landing_seen", "1"); setShowLanding(false); }} />;
  }

  if (!state.subscription.active && showOnboarding) {
    return <CreateAgentFlow onContinue={() => { sessionStorage.setItem("onboarding_seen", "1"); setShowOnboarding(false); }} />;
  }

  // Show subscription / choose plan page when not subscribed
  if (!state.subscription.active) {
    return (
      <div
        className="min-h-dvh bg-pin-gradient max-w-md mx-auto flex flex-col px-4"
        style={{
          paddingTop: "calc(var(--safe-top) + 1rem)",
          paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 1rem)",
        }}
      >
        <section className="glass-card rounded-2xl p-5 animate-fade-in shrink-0">
          <span className="pill bg-foreground text-background">PIN AI MINI</span>
          <h1 className="mt-3 font-heading text-xl font-bold leading-[1.1] text-foreground">
            Choose Your Plan
          </h1>
          <p className="mt-1.5 text-sm text-foreground/70">
            Subscribe to unlock your AI agent.
          </p>
        </section>

        <section className="glass-card rounded-2xl p-4 mt-3 animate-fade-in flex-1 flex flex-col min-h-0">
          <div className="flex-1 space-y-2.5 overflow-y-auto min-h-0">
            {state.plans.map((plan) => {
              const selected = selectedPlan === plan.id;
              return (
                <button
                  key={plan.id}
                  className={`w-full rounded-xl p-3.5 text-left transition-all btn-press ${
                    selected
                      ? "bg-white/60 border-2 border-primary shadow-lg"
                      : "bg-white/30 border border-white/40 hover:bg-white/40"
                  }`}
                  onClick={() => setSelectedPlan(plan.id)}
                >
                  <div className="flex items-center justify-between gap-2 mb-0.5">
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
          <div className="mt-3 shrink-0">
            <button
              className="w-full rounded-xl bg-foreground text-background px-4 py-3.5 text-sm font-bold shadow-lg btn-press disabled:opacity-50"
              onClick={() => void checkout()}
              disabled={busy !== "none" || !selectedPlan}
            >
              {busy === "checkout" ? "Redirecting..." : "Continue to Checkout"}
            </button>
          </div>
        </section>

        <div className="mt-3 text-center text-xs text-foreground/50 shrink-0">PIN AI</div>
      </div>
    );
  }

  // Show home page with agent when subscription is active
  if (state.assistant.exists) {
    return (
      <div
        className="min-h-dvh bg-pin-gradient max-w-md mx-auto flex flex-col"
        style={{
          paddingTop: "var(--safe-top)",
          paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 1rem)",
        }}
      >
        <TopStatus hasAgent={true} />

        <div className="px-4 mt-5 space-y-3 flex-1">
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

        <div className="px-4 mt-auto pt-4">
          <a
            href="mailto:support@pinai.io"
            className="glass-card rounded-2xl flex items-center justify-center gap-2 text-sm text-foreground font-medium py-3 hover:bg-secondary/50 transition-colors"
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

        <Toast message={toast?.message ?? null} type={toast?.type} onDismiss={() => setToast(null)} />
      </div>
    );
  }

  // Subscription active but assistant not yet created — show waiting screen
  // Auto-poll until assistant exists, with manual fallback after timeout
  return (
    <SetupWaiting
      onRetry={createAssistant}
      onPoll={loadState}
      busy={busy === "create"}
      toast={toast}
      onDismissToast={() => setToast(null)}
    />
  );
};

export default App;
