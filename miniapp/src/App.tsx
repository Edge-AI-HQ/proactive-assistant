import { useEffect, useState } from "react";

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
          Loading subscription center...
        </div>
      </div>
    );
  }

  if (error || !state) {
    return (
      <div className="mx-auto w-full max-w-2xl p-5">
        <div className="panel p-9 text-center text-sm text-red-700">
          Load failed: {error}
        </div>
      </div>
    );
  }

  if (!state.assistant.exists) {
    return (
      <div className="relative mx-auto w-full max-w-2xl p-4 pb-8">
        <div
          className="pointer-events-none fixed inset-0 opacity-[0.06]"
          style={{
            backgroundImage: "radial-gradient(#000 0.7px, transparent 0.7px)",
            backgroundSize: "3px 3px",
          }}
        />
        <section className="panel relative overflow-hidden p-5">
          <span className="pill bg-ink text-white">PIN AI MINI</span>
          <h1 className="mt-3 font-heading text-[30px] leading-[1.1]">
            Create Your Bot
          </h1>
          <p className="mt-2 max-w-md text-sm text-muted">
            No assistant was found. Run /create first, then return here for
            subscription and skills management.
          </p>
        </section>

        <section className="panel mt-3 p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="font-heading text-xl">/create</h2>
          </div>
          <p className="text-sm text-muted">
            Once an assistant record exists, this page unlocks subscription and
            runtime controls.
          </p>
          <div className="mt-3 grid gap-2">
            <button
              className="w-full rounded-xl bg-primary px-4 py-3 text-sm font-bold text-[#fff9f6] shadow-[0_10px_22px_rgba(235,74,39,0.3)] disabled:opacity-60"
              onClick={() => void createAssistant()}
              disabled={busy !== "none"}
            >
              {busy === "create" ? "Creating..." : "Create and Continue"}
            </button>
            <button
              className="w-full rounded-xl border border-dashed border-ink/10 px-4 py-3 text-sm font-semibold text-muted"
              onClick={() => void loadState()}
            >
              Refresh
            </button>
          </div>
        </section>
        <div className="mt-2 text-center text-xs text-muted">PIN AI · create</div>
      </div>
    );
  }

  return (
    <div className="relative mx-auto w-full max-w-2xl p-4 pb-8">
      <div
        className="pointer-events-none fixed inset-0 opacity-[0.06]"
        style={{
          backgroundImage: "radial-gradient(#000 0.7px, transparent 0.7px)",
          backgroundSize: "3px 3px",
        }}
      />
      <section className="panel relative overflow-hidden p-5">
        <span className="pill bg-ink text-white">PIN AI V3</span>
        <h1 className="mt-3 font-heading text-[30px] leading-[1.1]">
          Subscription Center
        </h1>
        <p className="mt-2 max-w-md text-sm text-muted">
          Your assistant is ready. Subscribe, upgrade, downgrade, and manage
          skills here.
        </p>
      </section>

      <section className="panel mt-3 p-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="font-heading text-xl">Runtime Status</h2>
          <span
            className={`pill ${state.subscription.active ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"}`}
          >
            {state.subscription.active ? "Active" : "Inactive"}
          </span>
        </div>
        <div className="text-sm text-muted">
          Status: {state.assistant.status || "unknown"}
        </div>
        <div className="mt-1 text-xs text-muted">
          Current plan: {state.subscription.plan_id || "none"}
        </div>
        {state.subscription.current_period_end ? (
          <div className="mt-1 text-xs text-muted">
            Period end: {state.subscription.current_period_end}
          </div>
        ) : null}
        {state.subscription.cancel_at_period_end ? (
          <div className="mt-1 text-xs text-amber-700">
            Renewal canceled (service ends at period end).
          </div>
        ) : null}
      </section>

      <section className="panel mt-3 p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="font-heading text-xl">Change Plan</h2>
          <span className="pill bg-ink/10 text-ink">Flexible</span>
        </div>

        <div className="grid gap-2">
          {state.plans.map((plan) => {
            const selected = selectedPlan === plan.id;
            const current = state.subscription.plan_id === plan.id;
            return (
              <button
                key={plan.id}
                className={`rounded-2xl border bg-white p-3 text-left ${selected ? "border-primary/50 ring-2 ring-primary/10" : "border-ink/10"}`}
                onClick={() => setSelectedPlan(plan.id)}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-bold">{plan.name}</span>
                  <span className="text-sm font-extrabold text-primary">
                    ${plan.price}/mo
                  </span>
                </div>
                <div className="mt-1 text-xs text-muted">
                  {plan.features.slice(0, 2).join(" · ")}
                  {current ? " · current" : ""}
                </div>
              </button>
            );
          })}
        </div>

        <div className="mt-3 grid gap-2">
          <button
            className="w-full rounded-xl bg-primary px-4 py-3 text-sm font-bold text-[#fff9f6] shadow-[0_10px_22px_rgba(235,74,39,0.3)] disabled:opacity-60"
            onClick={() => void checkout()}
            disabled={busy !== "none" || !selectedPlan}
          >
            {busy === "checkout" ? "Redirecting..." : "Continue to Checkout"}
          </button>
          <button
            className="w-full rounded-xl bg-ink/10 px-4 py-3 text-sm font-semibold text-ink disabled:opacity-60"
            onClick={() => void cancelSubscription()}
            disabled={busy !== "none"}
          >
            {busy === "cancel" ? "Processing..." : "Cancel Renewal"}
          </button>
        </div>
      </section>

      <section className="panel mt-3 p-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="font-heading text-xl">Skills</h2>
          <span className="pill bg-ink/10 text-ink">
            {state.skills.supported ? "Enabled" : "Pending"}
          </span>
        </div>
        <div className="text-sm text-muted">{state.skills.message}</div>
        {state.skills.supported ? (
          <div className="mt-3 grid gap-2">
            {(state.skills.items || []).map((skill) => {
              const installing = busy === `skill-install:${skill.key}`;
              const uninstalling = busy === `skill-uninstall:${skill.key}`;
              return (
                <div
                  key={skill.key}
                  className="rounded-xl border border-ink/10 bg-white p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-bold">{skill.name}</div>
                      <div className="mt-1 text-xs text-muted">
                        {skill.description}
                      </div>
                      <div className="mt-1 text-[11px] text-muted">
                        key: {skill.key} · {skill.installed ? "installed" : "not installed"}
                      </div>
                    </div>
                    {skill.enabled ? (
                      <button
                        className="rounded-lg bg-ink/10 px-3 py-2 text-xs font-semibold text-ink disabled:opacity-60"
                        onClick={() => void uninstallSkill(skill.key)}
                        disabled={busy !== "none"}
                      >
                        {uninstalling ? "Removing..." : "Remove"}
                      </button>
                    ) : (
                      <button
                        className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
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

      <div className="mt-2 text-center text-xs text-muted">PIN AI · v3</div>
    </div>
  );
};

export default App;
