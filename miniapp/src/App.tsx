import { useEffect, useMemo, useState } from "react";

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
      };
    };
  }
}

const getUserIdFromPath = (): string | null => {
  const match = window.location.pathname.match(/^\/gateway\/(\d+)\/mini$/);
  return match?.[1] ?? null;
};

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
    throw new Error((payload as { error?: string }).error || `HTTP ${response.status}`);
  }

  return payload as T;
};

const App = () => {
  const userId = useMemo(getUserIdFromPath, []);
  const [state, setState] = useState<StatePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedPlan, setSelectedPlan] = useState<string | null>(null);
  const [busy, setBusy] = useState<string>("none");

  const loadState = async () => {
    if (!userId) {
      setError("无效入口：缺少 user_id。");
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const payload = await safeFetch<StatePayload>(`/gateway/${userId}/mini/state`);
      setState(payload);
      setSelectedPlan((prev) => prev ?? payload.subscription.plan_id ?? payload.plans[0]?.id ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "unknown error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    window.Telegram?.WebApp?.ready?.();
    window.Telegram?.WebApp?.expand?.();
    void loadState();
  }, []);

  const createAssistant = async () => {
    if (!userId) return;
    setBusy("create");
    try {
      await safeFetch(`/gateway/${userId}/mini/create-assistant`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      await loadState();
    } catch (e) {
      alert(`创建失败：${e instanceof Error ? e.message : "unknown"}`);
    } finally {
      setBusy("none");
    }
  };

  const checkout = async () => {
    if (!userId || !selectedPlan) return;
    setBusy("checkout");
    try {
      const result = await safeFetch<{ url: string | null }>(`/gateway/${userId}/mini/checkout`, {
        method: "POST",
        body: JSON.stringify({ plan: selectedPlan }),
      });
      if (!result.url) throw new Error("missing checkout url");
      window.location.href = result.url;
    } catch (e) {
      alert(`无法创建支付会话：${e instanceof Error ? e.message : "unknown"}`);
      setBusy("none");
    }
  };

  const cancelSubscription = async () => {
    if (!userId) return;
    if (!window.confirm("确认取消续费？当前周期结束前仍可继续使用。")) return;
    setBusy("cancel");
    try {
      await safeFetch(`/gateway/${userId}/mini/cancel-subscription`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      alert("已设置为取消续费。当前周期结束前仍可继续使用。");
      await loadState();
    } catch (e) {
      alert(`取消续费失败：${e instanceof Error ? e.message : "unknown"}`);
      setBusy("none");
    }
  };

  const installSkill = async (skillKey: string) => {
    if (!userId) return;
    setBusy(`skill-install:${skillKey}`);
    try {
      await safeFetch(`/gateway/${userId}/mini/skills/install`, {
        method: "POST",
        body: JSON.stringify({ skill_key: skillKey }),
      });
      await loadState();
    } catch (e) {
      alert(`安装技能失败：${e instanceof Error ? e.message : "unknown"}`);
      setBusy("none");
    }
  };

  const uninstallSkill = async (skillKey: string) => {
    if (!userId) return;
    setBusy(`skill-uninstall:${skillKey}`);
    try {
      await safeFetch(`/gateway/${userId}/mini/skills/uninstall`, {
        method: "POST",
        body: JSON.stringify({ skill_key: skillKey }),
      });
      await loadState();
    } catch (e) {
      alert(`卸载技能失败：${e instanceof Error ? e.message : "unknown"}`);
      setBusy("none");
    }
  };

  if (loading) {
    return <div className="mx-auto w-full max-w-2xl p-5"><div className="panel p-9 text-center text-sm text-muted">正在加载订阅中心...</div></div>;
  }

  if (error || !state) {
    return <div className="mx-auto w-full max-w-2xl p-5"><div className="panel p-9 text-center text-sm text-red-700">加载失败：{error}</div></div>;
  }

  if (!state.assistant.exists) {
    return (
      <div className="relative mx-auto w-full max-w-2xl p-4 pb-8">
        <div className="pointer-events-none fixed inset-0 opacity-[0.06]" style={{ backgroundImage: "radial-gradient(#000 0.7px, transparent 0.7px)", backgroundSize: "3px 3px" }} />
        <section className="panel relative overflow-hidden p-5">
          <span className="pill bg-ink text-white">PIN AI MINI</span>
          <h1 className="mt-3 font-heading text-[30px] leading-[1.1]">创建你的 Bot</h1>
          <p className="mt-2 max-w-md text-sm text-muted">检测到你还没有创建 Assistant。先完成 /create 初始化，再进入订阅与管理。</p>
        </section>

        <section className="panel mt-3 p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="font-heading text-xl">/create</h2>
          </div>
          <p className="text-sm text-muted">
            创建 Assistant 记录后即可进入订阅管理页；订阅生效后会启动对应容器能力。
          </p>
          <div className="mt-3 grid gap-2">
            <button
              className="w-full rounded-xl bg-primary px-4 py-3 text-sm font-bold text-[#fff9f6] shadow-[0_10px_22px_rgba(235,74,39,0.3)] disabled:opacity-60"
              onClick={() => void createAssistant()}
              disabled={busy !== "none"}
            >
              {busy === "create" ? "创建中..." : "一键创建并继续"}
            </button>
            <button className="w-full rounded-xl border border-dashed border-ink/10 px-4 py-3 text-sm font-semibold text-muted" onClick={() => void loadState()}>
              刷新状态
            </button>
          </div>
        </section>
        <div className="mt-2 text-center text-xs text-muted">PIN AI · create</div>
      </div>
    );
  }

  return (
    <div className="relative mx-auto w-full max-w-2xl p-4 pb-8">
      <div className="pointer-events-none fixed inset-0 opacity-[0.06]" style={{ backgroundImage: "radial-gradient(#000 0.7px, transparent 0.7px)", backgroundSize: "3px 3px" }} />
      <section className="panel relative overflow-hidden p-5">
        <span className="pill bg-ink text-white">PIN AI V3</span>
        <h1 className="mt-3 font-heading text-[30px] leading-[1.1]">Subscription Center</h1>
        <p className="mt-2 max-w-md text-sm text-muted">你已创建 Assistant，可以在这里订阅、升级或降级计划。</p>
      </section>

      <section className="panel mt-3 p-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="font-heading text-xl">容器状态</h2>
          <span className={`pill ${state.subscription.active ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"}`}>
            {state.subscription.active ? "订阅生效中" : "未订阅或已过期"}
          </span>
        </div>
        <div className="text-sm text-muted">状态：{state.assistant.status || "unknown"}</div>
        <div className="mt-1 text-xs text-muted">当前计划：{state.subscription.plan_id || "none"}</div>
        {state.subscription.current_period_end ? (
          <div className="mt-1 text-xs text-muted">到期时间：{state.subscription.current_period_end}</div>
        ) : null}
        {state.subscription.cancel_at_period_end ? (
          <div className="mt-1 text-xs text-amber-700">已设置取消续费（到期后停用）</div>
        ) : null}
      </section>

      <section className="panel mt-3 p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="font-heading text-xl">变更订阅</h2>
          <span className="pill bg-ink/10 text-ink">可随时调整</span>
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
                  <span className="text-sm font-extrabold text-primary">${plan.price}/mo</span>
                </div>
                <div className="mt-1 text-xs text-muted">
                  {plan.features.slice(0, 2).join(" · ")}
                  {current ? " · 当前计划" : ""}
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
            {busy === "checkout" ? "跳转中..." : "继续到支付"}
          </button>
          <button
            className="w-full rounded-xl bg-ink/10 px-4 py-3 text-sm font-semibold text-ink disabled:opacity-60"
            onClick={() => void cancelSubscription()}
            disabled={busy !== "none"}
          >
            {busy === "cancel" ? "处理中..." : "取消续费"}
          </button>
        </div>
      </section>

      <section className="panel mt-3 p-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="font-heading text-xl">Skills</h2>
          <span className="pill bg-ink/10 text-ink">{state.skills.supported ? "Enabled" : "Pending"}</span>
        </div>
        <div className="text-sm text-muted">{state.skills.message}</div>
        {state.skills.supported ? (
          <div className="mt-3 grid gap-2">
            {(state.skills.items || []).map((skill) => {
              const installing = busy === `skill-install:${skill.key}`;
              const uninstalling = busy === `skill-uninstall:${skill.key}`;
              return (
                <div key={skill.key} className="rounded-xl border border-ink/10 bg-white p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-bold">{skill.name}</div>
                      <div className="mt-1 text-xs text-muted">{skill.description}</div>
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
                        {uninstalling ? "卸载中..." : "卸载"}
                      </button>
                    ) : (
                      <button
                        className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
                        onClick={() => void installSkill(skill.key)}
                        disabled={busy !== "none"}
                      >
                        {installing ? "安装中..." : "安装"}
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
