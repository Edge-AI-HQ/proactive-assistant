import { useEffect, useRef, useState } from "react";
import CreateAgentFlow from "./components/CreateAgentFlow";
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
    created_at?: string | null;
  };
  subscription: {
    active: boolean;
    status: string | null;
    plan_id: string | null;
    cancel_at_period_end: boolean;
    current_period_end: string | null;
    downgrade_lock_until: string | null;
    pending_plan_id: string | null;
  };
  credits?: {
    remaining: number;
    total: number;
  } | null;
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
  credits?: { remaining: number; total: number } | null;
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

const hasQuickPayloadChanged = (
  prev: StatePayload,
  next: StatePayload,
): boolean => {
  return (
    prev.user.telegram_user_id !== next.user.telegram_user_id ||
    prev.user.telegram_username !== next.user.telegram_username ||
    prev.assistant.exists !== next.assistant.exists ||
    prev.assistant.id !== next.assistant.id ||
    prev.assistant.username !== next.assistant.username ||
    prev.assistant.status !== next.assistant.status ||
    prev.subscription.active !== next.subscription.active ||
    prev.subscription.status !== next.subscription.status ||
    prev.subscription.plan_id !== next.subscription.plan_id ||
    prev.subscription.cancel_at_period_end !==
      next.subscription.cancel_at_period_end ||
    prev.subscription.current_period_end !==
      next.subscription.current_period_end ||
    prev.subscription.downgrade_lock_until !==
      next.subscription.downgrade_lock_until ||
    (prev.features?.can_delete_account ?? true) !==
      (next.features?.can_delete_account ?? true)
  );
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

const preloadImage = async (src: string, timeoutMs = 1200): Promise<void> => {
  await new Promise<void>((resolve) => {
    const img = new Image();
    let settled = false;

    const finalize = () => {
      if (settled) return;
      settled = true;
      img.onload = null;
      img.onerror = null;
      resolve();
    };

    const timeoutId = window.setTimeout(finalize, timeoutMs);
    img.onload = () => {
      window.clearTimeout(timeoutId);
      finalize();
    };
    img.onerror = () => {
      window.clearTimeout(timeoutId);
      finalize();
    };
    img.src = src;
  });
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
  const [toast, setToast] = useState<{
    message: string;
    type: "success" | "error";
  } | null>(null);
  const [models, setModels] = useState<{
    current: string | null;
    available: ModelItem[];
  } | null>(null);
  const handledGoogleRedirectRef = useRef(false);
  const refreshingOnResumeRef = useRef(false);

  const showToast = (message: string, type: "success" | "error" = "error") => {
    setToast({ message, type });
  };

  const hydrateState = (payload: StatePayload): void => {
    setState(payload);
    setSelectedPlan(
      (prev) =>
        prev ?? payload.subscription.plan_id ?? payload.plans?.[0]?.id ?? null,
    );
  };

  const loadDeferred = async (): Promise<DeferredPayload> => {
    const deferred = await safeFetch<DeferredPayload>(
      "/api/mini/state/deferred",
    );
    setState((prev) => (prev ? { ...prev, ...deferred } : prev));
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

  async function loadModels(): Promise<void> {
    try {
      const payload = await safeFetch<ModelsPayload>("/api/mini/models");
      setModels({
        current: payload.current_model,
        available: payload.available_models,
      });
    } catch {
      // non-critical — models section will just be empty
    }
  }

  const refreshStateOnReturn = async (): Promise<void> => {
    if (refreshingOnResumeRef.current) return;
    refreshingOnResumeRef.current = true;
    try {
      const [quick, deferred] = await Promise.all([
        safeFetch<StatePayload>("/api/mini/state"),
        safeFetch<DeferredPayload>("/api/mini/state/deferred"),
      ]);
      setState((prev) =>
        prev ? { ...prev, ...quick, ...deferred } : { ...quick, ...deferred },
      );
      setSelectedPlan(
        (prev) =>
          prev ?? quick.subscription.plan_id ?? deferred.plans[0]?.id ?? null,
      );
    } catch {
      // Best-effort refresh only. Existing state remains usable.
    } finally {
      refreshingOnResumeRef.current = false;
    }
  };

  const bootstrap = async (): Promise<{ loadedDeferred: boolean }> => {
    const initData = window.Telegram?.WebApp?.initData?.trim() ?? "";
    if (!initData) {
      throw new Error(
        "Please open this app through Telegram. Direct browser access is not supported.",
      );
    }

    const quick = await safeFetch<StatePayload>("/api/mini/bootstrap", {
      method: "POST",
      body: JSON.stringify({ init_data: initData }),
    });

    hydrateState(quick);
    setLoading(false);

    if (quick.assistant.exists) {
      void loadModels();
      void preloadImage("https://static.pinai.tech/pinclaw/bg-garden.jpg");
    }

    let loadedDeferred = false;
    try {
      const deferred = await safeFetch<DeferredPayload>(
        "/api/mini/state/deferred",
      );
      setState((prev) => (prev ? { ...prev, ...deferred } : prev));
      setSelectedPlan((prev) => prev ?? deferred.plans[0]?.id ?? null);
      loadedDeferred = true;
    } catch {
      // deferred will be retried via loadDeferred() below
    }

    return { loadedDeferred };
  };

  useEffect(() => {
    window.Telegram?.WebApp?.expand?.();
    const platform = window.Telegram?.WebApp?.platform;
    if (platform === "ios" || platform === "android") {
      window.Telegram?.WebApp?.requestFullscreen?.();
      document.documentElement.style.setProperty("--tg-top-offset", "56px");
    }

    window.Telegram?.WebApp?.ready?.();

    setLoading(true);
    setError(null);

    void bootstrap()
      .then(({ loadedDeferred }) => {
        if (!loadedDeferred) {
          void loadDeferred().catch(() => {});
        }
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "unknown error");
        setLoading(false);
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

  // Poll for status changes when assistant exists but isn't in a terminal state.
  // Skip polling while an action is in flight (e.g. repair-runtime) to avoid
  // server-side stale reads overwriting our optimistic UI state.
  useEffect(() => {
    if (!state?.assistant.exists) return;
    if (busy !== "none") return;
    const status = state.assistant.status;
    if (status === "running" || status === "error") return;

    const id = setInterval(() => {
      void safeFetch<StatePayload>("/api/mini/state")
        .then((quick) => {
          setState((prev) => {
            if (!prev) return prev;
            if (!hasQuickPayloadChanged(prev, quick)) return prev;
            return mergeQuickPayload(prev, quick);
          });
        })
        .catch(() => {});
    }, 3_000);

    return () => clearInterval(id);
  }, [state?.assistant.exists, state?.assistant.status, busy]);

  // Notify user when polled status reaches a terminal state after repair/create
  const prevStatusRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const curr = state?.assistant.status;
    const prev = prevStatusRef.current;
    prevStatusRef.current = curr;
    if (!prev || !curr || prev === curr) return;

    // Transition from non-running → running: repair/create succeeded
    if (prev !== "running" && curr === "running") {
      showToast("Agent is ready!", "success");
    }
    // Transition from non-error → error: probe failed
    if (prev !== "error" && curr === "error") {
      showToast("Agent failed to start. Try Repair again or contact support.");
    }
  }, [state?.assistant.status]);

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
              status:
                prev.assistant.status === "running" ? "running" : "creating",
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
    const targetPlan = selectedPlan;
    setBusy("checkout");
    try {
      const result = await safeFetch<{
        url: string | null;
        action?: string;
        message?: string;
      }>("/api/mini/checkout", {
        method: "POST",
        body: JSON.stringify({ plan: targetPlan }),
      });
      if (result.action === "upgrade" || result.action === "downgrade") {
        // Plan changed directly via Stripe subscription update — no redirect needed
        showToast(result.message ?? "Plan updated successfully.", "success");
        setState((prev) => {
          if (!prev) return prev;
          if (result.action === "upgrade") {
            return {
              ...prev,
              subscription: {
                ...prev.subscription,
                plan_id: targetPlan,
                cancel_at_period_end: false,
                pending_plan_id: null,
              },
            };
          }
          return {
            ...prev,
            subscription: {
              ...prev.subscription,
              pending_plan_id: targetPlan,
            },
          };
        });
        setSelectedPlan(targetPlan);
        setBusy("none");

        // Stripe webhook sync may lag briefly; poll state until server catches up.
        const maxAttempts = 6;
        for (let i = 0; i < maxAttempts; i += 1) {
          const latest = await loadState();
          const matched =
            result.action === "upgrade"
              ? latest.subscription.plan_id === targetPlan
              : latest.subscription.pending_plan_id === targetPlan ||
                latest.subscription.plan_id === targetPlan;
          if (matched) break;
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        return;
      }
      if (!result.url)
        throw new Error("Unable to get checkout URL. Please try again.");
      window.location.href = result.url;
    } catch (e) {
      const message = e instanceof Error ? e.message : "unknown";
      if (/downgrade is locked until/i.test(message)) {
        showToast("Downgrade is locked until the current billing cycle ends.");
      } else if (/downgrade is unavailable while renewal is canceled/i.test(message)) {
        showToast("Renewal is canceled. Resume renewal before downgrading.");
      } else {
        showToast(`Unable to change plan: ${message}`);
      }
      setBusy("none");
    }
  };

  const cancelSubscription = async () => {
    if (
      !window.confirm(
        "Cancel renewal? Service remains active until period end.",
      )
    ) {
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
      setState((prev) =>
        prev
          ? {
              ...prev,
              subscription: {
                ...prev.subscription,
                status: result.status,
                cancel_at_period_end: true,
                current_period_end: result.current_period_end,
              },
            }
          : prev,
      );
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

  const resumeSubscription = async () => {
    setBusy("resume");
    try {
      const result = await safeFetch<{
        ok: true;
        status: string;
        cancel_at_period_end: false;
        current_period_end: string;
        already_active?: boolean;
      }>("/api/mini/resume-subscription", {
        method: "POST",
        body: JSON.stringify({}),
      });
      setState((prev) =>
        prev
          ? {
              ...prev,
              subscription: {
                ...prev.subscription,
                status: result.status,
                cancel_at_period_end: false,
                current_period_end: result.current_period_end,
              },
            }
          : prev,
      );
      showToast(
        result.already_active
          ? "Renewal is already active."
          : "Renewal resumed successfully.",
        "success",
      );
      await loadState();
    } finally {
      setBusy("none");
    }
  };

  const handleResumeSubscription = async () => {
    try {
      await resumeSubscription();
    } catch (e) {
      showToast(`Resume failed: ${e instanceof Error ? e.message : "unknown"}`);
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
      const initData = window.Telegram?.WebApp?.initData?.trim() ?? "";
      const payload = await safeFetch<GoogleStartUrlPayload>(
        "/api/mini/google/start-url",
        {
          method: "POST",
          body: JSON.stringify(
            initData ? { init_data: initData } : {},
          ),
        },
      );
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
      await safeFetch<{ ok: true; message: string }>(
        "/api/mini/google/disconnect",
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      );
      await loadState();
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
    setShowManageAgent(false);
    setBusy("repair-runtime");
    // Capture current status so we can roll back on failure.
    const prevStatus = state?.assistant.status;
    // Immediately show transitional status — the API call (delete + create
    // on Fly) can take 5-30s and the user should see feedback right away.
    setState((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        assistant: { ...prev.assistant, status: "creating" },
      };
    });
    try {
      const result = await safeFetch<{
        ok: true;
        ready: boolean;
        deleted: boolean;
      }>("/api/mini/repair-runtime", {
        method: "POST",
        body: JSON.stringify({}),
      });
      // Sync with actual result — if already ready skip further polling.
      // The status-transition useEffect will handle the success toast.
      setState((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          assistant: {
            ...prev.assistant,
            status: result.ready ? "running" : "creating",
          },
        };
      });
      // If not ready yet, polling (useEffect) will keep refreshing until
      // status reaches "running" or "error".
    } catch (e) {
      // Roll back optimistic status so the UI doesn't stay stuck on "Creating..."
      setState((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          assistant: { ...prev.assistant, status: prevStatus ?? "error" },
        };
      });
      showToast(
        `Repair failed: ${e instanceof Error ? e.message : "unknown"}`,
      );
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

  const handleChangeModel = async (modelRef: string) => {
    setBusy("change-model");
    try {
      await safeFetch<{ ok: true; model: string }>("/api/mini/change-model", {
        method: "POST",
        body: JSON.stringify({ model: modelRef }),
      });
      setModels((prev) => (prev ? { ...prev, current: modelRef } : prev));
      showToast("Model changed successfully.", "success");
    } catch (e) {
      showToast(
        `Model change failed: ${e instanceof Error ? e.message : "unknown"}`,
      );
    } finally {
      setBusy("none");
    }
  };

  const handleOpenManage = () => {
    setShowManageAgent(true);
  };

  const handleBlockedAction = () => {
    showToast("Agent is starting. Please wait a moment.", "success");
  };

  if (loading) {
    return null;
  }

  if (error || !state) {
    const isAuthError =
      error?.includes("401") || error?.includes("Unauthorized");
    return (
      <div
        className="min-h-dvh bg-pin-gradient flex items-center justify-center p-5"
        style={{ paddingTop: "calc(var(--safe-top) + 1.25rem)" }}
      >
        <div className="glass-card rounded-2xl p-6 max-w-md text-center">
          <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center mx-auto mb-4">
            <svg
              className="w-8 h-8 text-destructive"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
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
    return (
      <VideoLanding
        onGetStarted={() => {
          sessionStorage.setItem("landing_seen", "1");
          setShowLanding(false);
        }}
      />
    );
  }

  if (!state.subscription.active && showOnboarding) {
    return (
      <CreateAgentFlow
        onBack={() => {
          sessionStorage.removeItem("landing_seen");
          setShowLanding(true);
        }}
        onContinue={() => {
          sessionStorage.setItem("onboarding_seen", "1");
          setShowOnboarding(false);
        }}
      />
    );
  }

  // Show subscription / choose plan page when not subscribed
  if (!state.subscription.active) {
    const planBadge: Record<string, string> = { pro: "Most Popular", max: "Best Value" };
    const planPromo: Record<string, { original: string; actual: string; multiplier: string }> = {
      basic: { original: "1,600", actual: "3,200", multiplier: "2x" },
      pro: { original: "4,100", actual: "12,800", multiplier: "3x" },
      max: { original: "8,200", actual: "28,800", multiplier: "3.5x" },
    };

    return (
      <div className="fixed inset-0 z-[9999] bg-pin-gradient animate-fade-in">
        <div
          className="max-w-md mx-auto h-full flex flex-col"
          style={{
            paddingTop: "calc(var(--safe-top) + 0.75rem)",
            paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 0.75rem)",
          }}
        >
          <div className="relative flex items-center justify-center px-5 py-3 shrink-0">
            <button
              onClick={() => {
                sessionStorage.removeItem("onboarding_seen");
                setShowOnboarding(true);
              }}
              className="absolute left-4 w-8 h-8 flex items-center justify-center rounded-xl hover:bg-black/5 transition-colors"
            >
              <svg
                className="w-5 h-5 text-foreground"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M15 19l-7-7 7-7"
                />
              </svg>
            </button>
            <h2 className="text-sm font-semibold text-foreground">PIN Claw</h2>
          </div>

          <div className="flex-1 flex flex-col px-5 min-h-0 overflow-y-auto">
            <div className="text-center mb-5">
              <h1 className="text-2xl font-bold text-foreground mb-1.5">
                Choose Your Plan
              </h1>
              <p className="text-sm text-muted-foreground">
                Subscribe to unlock your AI agent.
              </p>
            </div>

            <div className="space-y-3 flex-1">
              {state.plans === null
                ? Array.from({ length: 3 }).map((_, i) => (
                    <div
                      key={i}
                      className="w-full rounded-2xl p-4 bg-white border border-border/20 animate-pulse"
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div className="h-5 w-20 bg-secondary rounded" />
                        <div className="h-6 w-24 bg-secondary rounded" />
                      </div>
                      <div className="h-3 w-48 bg-secondary/60 rounded" />
                    </div>
                  ))
                : state.plans.map((plan) => {
                    const selected = selectedPlan === plan.id;
                    const badge = planBadge[plan.id];
                    return (
                      <button
                        key={plan.id}
                        className={`w-full rounded-2xl p-4 text-left transition-all btn-press relative ${
                          selected
                            ? "bg-white border-2 border-foreground shadow-md"
                            : "bg-white border border-border/20 shadow-sm hover:shadow-md"
                        }`}
                        onClick={() => setSelectedPlan(plan.id)}
                      >
                        {badge && (
                          <span
                            className={`absolute -top-2.5 right-4 text-[10px] font-semibold px-2.5 py-0.5 rounded-full ${
                              plan.id === "pro"
                                ? "bg-primary text-white"
                                : "bg-foreground text-background"
                            }`}
                          >
                            {badge}
                          </span>
                        )}
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <span className="text-base font-bold text-foreground">
                            {plan.name}
                          </span>
                          <span className="text-lg font-extrabold text-foreground">
                            ${plan.price}
                            <span className="text-sm font-normal text-muted-foreground">
                              /mo
                            </span>
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {plan.features[0]}
                        </p>
                        <p className="text-[12px] font-medium text-primary mt-1">
                          <span className="line-through text-muted-foreground text-[11px]">{planPromo[plan.id]?.original ?? "—"}</span>
                          {" "}
                          <span className="font-bold">{planPromo[plan.id]?.actual ?? "—"} credits</span>
                          {" "}
                          <span className="text-[10px] text-primary/70">{planPromo[plan.id]?.multiplier ?? ""}</span>
                        </p>
                      </button>
                    );
                  })}
            </div>

            <p className="text-center text-[10px] text-muted-foreground mt-4 mb-1">
              Limited-time offer for early subscribers.
            </p>
          </div>

          <div className="shrink-0 px-5 pt-3">
            <button
              className="w-full bg-foreground text-background rounded-2xl py-3.5 text-base font-semibold btn-press shadow-md disabled:opacity-50"
              onClick={() => void checkout()}
              disabled={busy !== "none" || !selectedPlan}
            >
              {busy === "checkout" ? "Redirecting..." : "Continue to Checkout"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Show home page with agent when subscription is active
  if (state.assistant.exists) {
    return (
      <div
        className="relative min-h-dvh bg-pin-gradient max-w-md mx-auto flex flex-col overflow-hidden"
        style={{
          paddingTop: "var(--safe-top)",
          paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 1rem)",
        }}
      >
        <div
          className="fixed inset-0 z-0 opacity-[0.9] pointer-events-none"
          style={{
            backgroundImage:
              "url('https://static.pinai.tech/pinclaw/bg-garden.jpg')",
            backgroundSize: "cover",
            backgroundPosition: "center",
          }}
        />

        <div className="relative px-4 pt-4 flex-1 z-10">
          <AgentCard
            username={state.assistant.username || null}
            status={state.assistant.status || "unknown"}
            planId={state.subscription.plan_id}
            skillsCount={
              state.skills?.items?.filter((item) => item.installed).length ?? 0
            }
            skills={state.skills?.items ?? []}
            active={state.subscription.active}
            manageOpen={showManageAgent}
            credits={state.credits ?? null}
            google={state.google ?? undefined}
            googleBusy={
              busy === "google-disconnect" || busy === "google-connect"
            }
            onOpenManage={handleOpenManage}
            onCloseManage={() => setShowManageAgent(false)}
            onChangePlan={() => {
              setSelectedPlan(
                state.subscription.plan_id ?? state.plans?.[0]?.id ?? null,
              );
              setShowChangePlan(true);
            }}
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
            onBlockedAction={handleBlockedAction}
          />
        </div>

        <div className="relative z-[1] px-4 mt-auto pt-4">
          <button
            type="button"
            onClick={handleContactSupport}
            className="glass-stat-box w-full rounded-2xl flex items-center justify-center gap-2 text-sm text-foreground font-medium py-3.5 hover:bg-white/40 transition-colors border-0 bg-transparent appearance-none"
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
                d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
              />
            </svg>
            Contact Us
          </button>

          <div className="mt-3 pb-4 flex items-center justify-center gap-3 text-xs text-foreground/60">
            <a
              href="/mini/privacy-policy.html"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-foreground/80 transition-colors underline"
            >
              Privacy Policy
            </a>
            <span className="text-foreground/40">•</span>
            <a
              href="/mini/terms-of-service.html"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-foreground/80 transition-colors underline"
            >
              Terms of Service
            </a>
          </div>
        </div>

        <div className="relative z-20">
          <ChangePlanDialog
            open={showChangePlan}
            onClose={() => setShowChangePlan(false)}
            plans={state.plans ?? []}
            currentPlanId={state.subscription.plan_id}
            cancelAtPeriodEnd={state.subscription.cancel_at_period_end}
            currentPeriodEnd={state.subscription.current_period_end}
            downgradeLockUntil={state.subscription.downgrade_lock_until}
            pendingPlanId={state.subscription.pending_plan_id}
            selectedPlan={selectedPlan}
            onSelectPlan={setSelectedPlan}
            onCheckout={checkout}
            onCancel={handleCancelSubscription}
            onResume={handleResumeSubscription}
            busy={busy}
          />

          <Toast
            message={toast?.message ?? null}
            type={toast?.type}
            onDismiss={() => setToast(null)}
          />
        </div>
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
