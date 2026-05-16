import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import { LockKeyhole } from "lucide-react";
import { authConfigured, supabase } from "@/auth/supabase";
import { oauthRedirectTo } from "@/auth/redirect";
import { Layout } from "@/components/Layout";
import { StateBlock } from "@/components/StateBlock";
import { CardView } from "@/routes/CardView";
import { CasebookView } from "@/routes/CasebookView";
import { PatternDetailView } from "@/routes/PatternDetailView";
import { PatternsHealthView } from "@/routes/PatternsHealthView";
import { PatternsPendingView } from "@/routes/PatternsPendingView";
import { PatternsRetiredView } from "@/routes/PatternsRetiredView";
import { PatternsView } from "@/routes/PatternsView";
import { PersonalDataView } from "@/routes/PersonalDataView";
import { RunDetailView } from "@/routes/RunDetailView";
import { RunsView } from "@/routes/RunsView";
import { TraceView } from "@/routes/TraceView";
import { dashboardDocumentTitle, parseDashboardRoute, shouldPushDashboardPath } from "@/lib/dashboardRoutes";

function LoginPanel() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!supabase) return;
    setBusy(true);
    setError(null);
    const { error: signInError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: oauthRedirectTo(),
        queryParams: { prompt: "select_account" },
      },
    });
    if (signInError) setError(signInError.message);
    setBusy(false);
  }

  return (
    <div className="auth-screen">
      <form className="auth-panel" onSubmit={submit}>
        <div className="auth-icon"><LockKeyhole size={22} /></div>
        <h1>卡片评审台</h1>
        <p>使用 PIN AI 应用里的同一个 Google 账号登录。</p>
        <button className="primary-button" type="submit" disabled={busy}>
          {busy ? "正在打开 Google" : "继续使用 Google 登录"}
        </button>
        {error && <div className="inline-error" role="alert">{error}</div>}
      </form>
    </div>
  );
}

// Dev-only stand-in session used when local reviewers want to verify the
// dashboard without going through Supabase OAuth. Activated by
// localStorage.__devAuthBypass=1 in a DEV build (Vite import.meta.env.DEV).
// The dashboard API client mirrors the flag and adds X-Dev-Auth so the
// backend's DEPLOY_ENV=dev-gated bypass mints the matching test user.
function isDevAuthBypassActive(): boolean {
  if (!import.meta.env.DEV) return false;
  try {
    return window.localStorage.getItem("__devAuthBypass") === "1";
  } catch {
    return false;
  }
}

function devAuthSession(): Session {
  // Cast to Session — only used to populate Layout email/name/avatar.
  // Supabase signOut / accessToken paths are not exercised when bypass is on.
  return {
    access_token: "dev-bypass",
    refresh_token: "dev-bypass",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    expires_in: 3600,
    token_type: "bearer",
    user: {
      id: "dev-bypass",
      email: "dev-reviewer@local.invalid",
      aud: "authenticated",
      role: "authenticated",
      app_metadata: { provider: "dev-bypass" },
      user_metadata: { full_name: "Dev Reviewer" },
      created_at: new Date().toISOString(),
    },
  } as unknown as Session;
}


export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [path, setPath] = useState(() => window.location.pathname);
  const route = useMemo(() => parseDashboardRoute(path), [path]);
  const userProfile = useMemo(() => {
    if (!session) return { name: null, avatarUrl: null };
    const textValue = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
    const metadata = session.user.user_metadata;
    const name = textValue(metadata.full_name) ?? textValue(metadata.name);
    const avatarUrl = textValue(metadata.avatar_url) ?? textValue(metadata.picture);
    return { name, avatarUrl };
  }, [session]);

  useEffect(() => {
    if (isDevAuthBypassActive()) {
      setSession(devAuthSession());
      setLoading(false);
      return;
    }
    if (!supabase) {
      setLoading(false);
      return;
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    document.title = dashboardDocumentTitle(route);
  }, [route]);

  function navigate(nextPath: string) {
    if (!shouldPushDashboardPath(window.location.pathname, nextPath)) {
      document.getElementById("dashboard-main")?.focus();
      return;
    }
    setPath(nextPath);
    window.history.pushState({}, "", nextPath);
    window.requestAnimationFrame(() => {
      document.getElementById("dashboard-main")?.focus();
    });
  }

  if (!authConfigured) {
    return (
      <StateBlock
        title="缺少 Supabase 环境变量"
        detail="需要设置 VITE_SUPABASE_URL 和 VITE_SUPABASE_PUBLISHABLE_KEY。Vite 配置会从 pinai-agents/.env 读取。"
      />
    );
  }
  if (loading) return <StateBlock title="正在读取登录状态" />;
  if (!session) return <LoginPanel />;

  return (
    <Layout
      route={path}
      email={session.user.email ?? null}
      name={userProfile.name}
      avatarUrl={userProfile.avatarUrl}
      onNavigate={navigate}
      onSignOut={() => {
        void supabase?.auth.signOut();
      }}
    >
      {route.kind === "runs" && <RunsView onNavigate={navigate} />}
      {route.kind === "run" && <RunDetailView runId={route.runId} onNavigate={navigate} />}
      {route.kind === "card" && <CardView cardId={route.cardId} onNavigate={navigate} />}
      {route.kind === "casebook" && <CasebookView onNavigate={navigate} />}
      {route.kind === "personal-data" && <PersonalDataView onNavigate={navigate} />}
      {route.kind === "trace" && <TraceView runId={route.runId} onNavigate={navigate} />}
      {route.kind === "patterns" && <PatternsView onNavigate={navigate} />}
      {route.kind === "pattern" && (
        <PatternDetailView patternId={route.patternId} onNavigate={navigate} />
      )}
      {route.kind === "patterns-pending" && (
        <PatternsPendingView onNavigate={navigate} />
      )}
      {route.kind === "patterns-health" && (
        <PatternsHealthView onNavigate={navigate} />
      )}
      {route.kind === "patterns-retired" && (
        <PatternsRetiredView onNavigate={navigate} />
      )}
    </Layout>
  );
}
