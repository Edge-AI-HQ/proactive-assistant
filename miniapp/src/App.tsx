import { useEffect, useRef, useState } from "react";
import CreateAgentFlow from "./components/CreateAgentFlow";
import TopStatus from "./components/TopStatus";
import AgentCard from "./components/AgentCard";
import ChangePlanDialog from "./components/ChangePlanDialog";
import VideoLanding from "./components/VideoLanding";
import SetupWaiting from "./components/SetupWaiting";
import Toast from "./components/Toast";
import { readGoogleRedirectState } from "./googleRedirectState";
import { shouldRefreshAfterExternalOAuthReturn } from "./googleReconnectRefresh";

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

type GoogleStatus = {
  connected: boolean;
  email: string | null;
  scopes: string;
  updatedAt: string;
};

type SkillsPayload = {
  supported: boolean;
  message: string;
  items: SkillItem[];
  config?: Record<string, unknown> | null;
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
  features?: {
    can_delete_account?: boolean;
  };
  plans: Plan[] | null;
  skills: SkillsPayload | null;
  google: GoogleStatus | null;
};

type DeferredPayload = {
  plans: Plan[];
  skills: SkillsPayload;
  google: GoogleStatus;
};

type ModelItem = {
  id: string;
  ref: string;
};

type ModelsPayload = {
  ok: boolean;
  current_model: string;
  default_model: string;
  available_models: ModelItem[];
};

type GoogleStartUrlPayload = {
  url: string;
};

const mergeQuickPayload = (
  prev: StatePayload,
  quick: StatePayload,
): StatePayload => ({
  ...prev,
  ...quick,
  // quick payload intentionally omits heavy fields; keep last known values
  plans: quick.plans ?? prev.plans,
  skills: quick.skills ?? prev.skills,
  google: quick.google ?? prev.google,
});

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
        openLink?: (
          url: string,
          options?: {
            try_instant_view?: boolean;
            try_browser?: string;
          },
        ) => void;
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
  const [loading, setLoading] = useState(true); // true until bootstrap completes; Telegram native loader covers this
  const [selectedPlan, setSelectedPlan] = useState<string | null>(null);
  const [busy, setBusy] = useState<string>("none");
  const [showChangePlan, setShowChangePlan] = useState(false);
  const [showManageAgent, setShowManageAgent] = useState(false);
  const [showLanding, setShowLanding] = useState(
    () => !sessionStorage.getItem("landing_seen"),
  );
  const [showOnboarding, setShowOnboarding] = useState(
    () => !sessionStorage.getItem("onboarding_seen"),
  );
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
  const [models, setModels] = useState<{ current: string | null; available: ModelItem[] } | null>(null);
  const handledGoogleRedirectRef = useRef(false);
  const refreshingOnResumeRef = useRef(false);

  const showToast = (message: string, type: "success" | "error" = "error") => {
    setToast({ message, type });
  };

  const hydrateState = (payload: StatePayload): void => {
    setState(payload);
    setSelectedPlan(
      (prev) => prev ?? payload.subscription.plan_id ?? payload.plans?.[0]?.id ?? null,
    );
  };

  const loadDeferred = async (): Promise<DeferredPayload> => {
    const deferred = await safeFetch<DeferredPayload>("/api/mini/state/deferred");
    setState((prev) => prev ? { ...prev, ...deferred } : prev);
    setSelectedPlan((prev) => prev ?? deferred.plans[0]?.id ?? null);
    return deferred;
  };

  const consumeGoogleRedirect = async (): Promise<void> => {
    const redirectState = readGoogleRedirectState(window.location.search);
    if (redirectState.kind === "idle") return;

    // Google redirect needs full data including google status
    const deferred = await loadDeferred();
    if (redirectState.manage) {
      setShowManageAgent(true);
    }

    if (redirectState.kind === "connected") {
      const email = deferred.google.email || "";
      showToast(
        email
          ? `Google connected: ${email}. Return to Telegram to use email actions.`
          : "Google connected. Return to Telegram to use email actions.",
        "success",
      );
    } else if (redirectState.kind === "disconnected") {
      showToast("Google disconnected.", "success");
    } else {
      showToast(`Google connection failed: ${redirectState.reason}`);
    }

    window.history.replaceState({}, "", window.location.pathname);
  };

  const loadState = async () => {
    const [quick, deferred] = await Promise.all([
      safeFetch<StatePayload>("/api/mini/state"),
      safeFetch<DeferredPayload>("/api/mini/state/deferred"),
    ]);
    const payload: StatePayload = { ...quick, ...deferred };
    hydrateState(payload);
    return payload;
  };

  const refreshStateOnReturn = async (): Promise<void> => {
    if (refreshingOnResumeRef.current) return;
    refreshingOnResumeRef.current = true;
    try {
      const [quick, deferred] = await Promise.all([
        safeFetch<StatePayload>("/api/mini/state"),
        safeFetch<DeferredPayload>("/api/mini/state/deferred"),
      ]);
      setState((prev) => (prev ? { ...prev, ...quick, ...deferred } : { ...quick, ...deferred }));
      setSelectedPlan((prev) => prev ?? quick.subscription.plan_id ?? deferred.plans[0]?.id ?? null);
    } catch {
      // Best-effort refresh only. Existing state remains usable.
    } finally {
      refreshingOnResumeRef.current = false;
    }
  };

  const bootstrap = async () => {
    const initData = window.Telegram?.WebApp?.initData?.trim() ?? "";

    if (initData) {
      const payload = await safeFetch<StatePayload>("/api/mini/bootstrap", {
        method: "POST",
        body: JSON.stringify({ init_data: initData }),
      });
      hydrateState(payload);
      return;
    }
    await loadState();
  };

  useEffect(() => {
    // expand/fullscreen can be called early — they don't dismiss the native loader
    window.Telegram?.WebApp?.expand?.();
    const platform = window.Telegram?.WebApp?.platform;
    if (platform === 'ios' || platform === 'android') {
      window.Telegram?.WebApp?.requestFullscreen?.();
      document.documentElement.style.setProperty("--tg-top-offset", "56px");
    }
    setLoading(true);
    setError(null);

    void bootstrap()
      .then(() => {
        setLoading(false);
        // Signal Telegram that the page is ready — dismisses native loader
        window.Telegram?.WebApp?.ready?.();
        // Fire deferred load in background (plans, google, skills)
        void loadDeferred().catch(() => {});
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "unknown error");
        setLoading(false);
        // Still need to dismiss native loader on error so user sees error UI
        window.Telegram?.WebApp?.ready?.();
      });
  }, []);

  useEffect(() => {
    if (loading || !state) return;
    if (handledGoogleRedirectRef.current) return;
    if (!window.location.search.includes("google=")) return;
    handledGoogleRedirectRef.current = true;
    void consumeGoogleRedirect();
  }, [loading, state]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (
        !shouldRefreshAfterExternalOAuthReturn({
          eventType: "visibilitychange",
          visibilityState: document.visibilityState,
          loading,
          hasState: Boolean(state),
          busy,
        })
      ) {
        return;
      }
      void refreshStateOnReturn();
    };

    const onFocus = () => {
      if (
        !shouldRefreshAfterExternalOAuthReturn({
          eventType: "focus",
          visibilityState: document.visibilityState,
          loading,
          hasState: Boolean(state),
          busy,
        })
      ) {
        return;
      }
      void refreshStateOnReturn();
    };

    const onPageShow = () => {
      if (
        !shouldRefreshAfterExternalOAuthReturn({
          eventType: "pageshow",
          visibilityState: document.visibilityState,
          loading,
          hasState: Boolean(state),
          busy,
        })
      ) {
        return;
      }
      void refreshStateOnReturn();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onFocus);
    window.addEventListener("pageshow", onPageShow);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [busy, loading, state]);

  // Poll for status changes when assistant exists but isn't running yet
  useEffect(() => {
    if (!state?.assistant.exists) return;
    if (state.assistant.status === "running") return;

    const id = setInterval(() => {
      void safeFetch<StatePayload>("/api/mini/state").then((quick) => {
        setState((prev) => (prev ? mergeQuickPayload(prev, quick) : prev));
      }).catch(() => {});
    }, 3_000);

    return () => clearInterval(id);
  }, [state?.assistant.exists, state?.assistant.status]);

  const createAssistant = async () => {
    setBusy("create");
    setState((prev) =>
      prev
        ? {
            ...prev,
            assistant: {
              exists: true,
              id: prev.assistant.id,
              username: prev.assistant.username ?? null,
              status: prev.assistant.status === "running" ? "running" : "creating",
            },
          }
        : prev,
    );
    try {
      await safeFetch("/api/mini/create-assistant", {
        method: "POST",
        body: JSON.stringify({}),
      });
      await loadState();
    } catch (e) {
      await loadState().catch(() => {});
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
      const message = e instanceof Error ? e.message : "unknown";
      if (/downgrade is locked until/i.test(message)) {
        showToast("Downgrade is locked until the current billing cycle ends.");
      } else {
        showToast(`Unable to change plan: ${message}`);
      }
      setBusy("none");
    }
  };

  const cancelSubscription = async () => {
    if (!window.confirm("Cancel renewal? Service remains active until period end.")) {
      return;
    }
    setBusy("cancel");
    try {
      const result = await safeFetch<{
        ok: true;
        status: string;
        cancel_at_period_end: true;
        current_period_end: string;
        already_scheduled?: boolean;
      }>("/api/mini/cancel-subscription", {
        method: "POST",
        body: JSON.stringify({}),
      });
      setState((prev) => prev ? {
        ...prev,
        subscription: {
          ...prev.subscription,
          status: result.status,
          cancel_at_period_end: true,
          current_period_end: result.current_period_end,
        },
      } : prev);
      showToast(
        result.already_scheduled
          ? "Renewal was already canceled. Service remains active until period end."
          : "Renewal canceled. Service remains active until period end.",
        "success",
      );
      await loadState();
    } finally {
      setBusy("none");
    }
  };

  const handleCancelSubscription = async () => {
    try {
      await cancelSubscription();
    } catch (e) {
      showToast(`Cancel failed: ${e instanceof Error ? e.message : "unknown"}`);
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

  const handleConnectGoogle = async () => {
    setBusy("google-connect");
    try {
      const payload = await safeFetch<GoogleStartUrlPayload>("/api/mini/google/start-url", {
        method: "POST",
        body: JSON.stringify({}),
      });
      const authUrl = String(payload.url || "").trim();
      if (!authUrl) {
        throw new Error("Missing Google auth URL");
      }
      const webApp = window.Telegram?.WebApp;
      if (webApp?.openLink) {
        webApp.openLink(authUrl, { try_browser: "chrome" });
      } else {
        window.open(authUrl, "_blank", "noopener,noreferrer");
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "unknown";
      if (/unauthorized/i.test(message)) {
        window.location.reload();
        return;
      }
      showToast(`Google connect failed: ${message}`);
    } finally {
      setBusy("none");
    }
  };

  const handleDisconnectGoogle = async () => {
    setBusy("google-disconnect");
    try {
      await safeFetch<{ ok: true; message: string }>("/api/mini/google/disconnect", {
        method: "POST",
        body: JSON.stringify({}),
      });
      await loadState();
      setShowManageAgent(true);
      showToast("Google disconnected.", "success");
    } catch (e) {
      const message = e instanceof Error ? e.message : "unknown";
      if (/unauthorized/i.test(message)) {
        window.location.reload();
        return;
      }
      showToast(`Disconnect failed: ${message}`);
    } finally {
      setBusy("none");
    }
  };

  const handleRepairRuntime = async () => {
    setBusy("repair-runtime");
    try {
      await safeFetch<{ ok: true; ready: boolean }>("/api/mini/repair-runtime", {
        method: "POST",
        body: JSON.stringify({}),
      });
      showToast("Runtime repair started. The assistant may take a moment to become ready again.", "success");
      await loadState();
    } catch (e) {
      showToast(`Repair failed: ${e instanceof Error ? e.message : "unknown"}`);
    } finally {
      setBusy("none");
    }
  };

  const handleContactSupport = () => {
    const supportUrl = `${window.location.origin}/mini/support.html`;
    const webApp = window.Telegram?.WebApp;

    if (webApp?.openLink) {
      webApp.openLink(supportUrl, { try_browser: "chrome" });
      return;
    }

    window.open(supportUrl, "_blank", "noopener,noreferrer");
  };

  const loadModels = async () => {
    try {
      const payload = await safeFetch<ModelsPayload>("/api/mini/models");
      setModels({
        current: payload.current_model,
        available: payload.available_models,
      });
    } catch {
      // non-critical — models section will just be empty
    }
  };

  const handleChangeModel = async (modelRef: string) => {
    setBusy("change-model");
    try {
      await safeFetch<{ ok: true; model: string }>("/api/mini/change-model", {
        method: "POST",
        body: JSON.stringify({ model: modelRef }),
      });
      setModels((prev) => prev ? { ...prev, current: modelRef } : prev);
      showToast("Model changed successfully.", "success");
    } catch (e) {
      showToast(`Model change failed: ${e instanceof Error ? e.message : "unknown"}`);
    } finally {
      setBusy("none");
    }
  };

  const handleOpenManage = () => {
    setShowManageAgent(true);
  };

  // Telegram native loader covers the bootstrap wait — render empty background
  if (loading) {
    return <div className="min-h-dvh bg-pin-gradient" />;
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
            {state.plans === null ? (
              /* Skeleton placeholders while plans load */
              Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="w-full rounded-xl p-3.5 bg-white/30 border border-white/40 animate-pulse">
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <div className="h-4 w-24 bg-white/50 rounded" />
                    <div className="h-5 w-16 bg-white/50 rounded" />
                  </div>
                  <div className="h-3 w-40 bg-white/40 rounded" />
                </div>
              ))
            ) : (
              state.plans.map((plan) => {
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
              })
            )}
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
            manageOpen={showManageAgent}
            google={state.google ?? undefined}
            googleBusy={busy === "google-disconnect" || busy === "google-connect"}
            onOpenManage={() => {
              void handleOpenManage();
            }}
            onCloseManage={() => setShowManageAgent(false)}
            onChangePlan={() => setShowChangePlan(true)}
            onRepairRuntime={handleRepairRuntime}
            runtimeBusy={busy === "repair-runtime"}
            allowDeleteAccount={state.features?.can_delete_account ?? true}
            onDeleteAccount={handleDeleteAccount}
            onConnectGoogle={handleConnectGoogle}
            onDisconnectGoogle={handleDisconnectGoogle}
            models={models}
            modelBusy={busy === "change-model"}
            onChangeModel={handleChangeModel}
            onLoadModels={loadModels}
          />
        </div>

        <div className="px-4 mt-auto pt-4">
          <button
            type="button"
            onClick={handleContactSupport}
            className="glass-card w-full rounded-2xl flex items-center justify-center gap-2 text-sm text-foreground font-medium py-3 hover:bg-secondary/50 transition-colors border-0 bg-transparent appearance-none"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
            Contact Us
          </button>
        </div>

        <ChangePlanDialog
          open={showChangePlan}
          onClose={() => setShowChangePlan(false)}
          plans={state.plans ?? []}
          currentPlanId={state.subscription.plan_id}
          cancelAtPeriodEnd={state.subscription.cancel_at_period_end}
          currentPeriodEnd={state.subscription.current_period_end}
          selectedPlan={selectedPlan}
          onSelectPlan={setSelectedPlan}
          onCheckout={checkout}
          onCancel={handleCancelSubscription}
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
      onPoll={() => loadState().then(() => undefined)}
      busy={busy === "create"}
      toast={toast}
      onDismissToast={() => setToast(null)}
    />
  );
};

export default App;
