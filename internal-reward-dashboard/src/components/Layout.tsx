import { BarChart3, BookOpen, Brain, Clock3, Database, GitBranch, LogOut, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { dashboardNavPath, dashboardRouteTitle, dashboardRoutes, parseDashboardRoute } from "@/lib/dashboardRoutes";
import { safeExternalHref } from "@/lib/externalUrl";

interface LayoutProps {
  children: ReactNode;
  route: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
  onNavigate: (path: string) => void;
  onSignOut: () => void;
}

const nav = [
  { path: dashboardRoutes.runs, label: "生成批次", icon: BarChart3 },
  { path: dashboardRoutes.patterns, label: "认知范式库", icon: Brain },
  { path: dashboardRoutes.personalData, label: "个人数据", icon: Database },
  { path: dashboardRoutes.casebook, label: "样本库", icon: BookOpen },
];

export function Layout({ children, route, email, name, avatarUrl, onNavigate, onSignOut }: LayoutProps) {
  const [now, setNow] = useState(() => new Date());
  const dashboardRoute = parseDashboardRoute(route);
  const activeNavPath = dashboardNavPath(dashboardRoute);
  const title = dashboardRouteTitle(dashboardRoute);
  const displayName = name ?? email ?? "已登录用户";
  const safeAvatarUrl = safeExternalHref(avatarUrl);
  const initials = useMemo(() => {
    const source = displayName.trim();
    return (source ? source.slice(0, 1) : "U").toUpperCase();
  }, [displayName]);
  const timeLabel = useMemo(
    () =>
      new Intl.DateTimeFormat("zh-CN", {
        month: "short",
        day: "numeric",
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
      }).format(now),
    [now],
  );

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="shell">
      <a className="skip-link" href="#dashboard-main">跳到主内容</a>
      <aside aria-label="工作区侧边栏" className="sidebar">
        <div className="brand">
          <GitBranch size={22} />
          <div>
            <div className="brand-title">卡片评审台</div>
            <div className="brand-subtitle">卡片生成评审台</div>
          </div>
        </div>
        <nav aria-label="主导航" className="nav-list">
          {nav.map((item) => {
            const Icon = item.icon;
            const active = activeNavPath === item.path;
            return (
              <button
                key={item.path}
                aria-current={active ? "page" : undefined}
                className={`nav-item ${active ? "active" : ""}`}
                onClick={() => onNavigate(item.path)}
                type="button"
              >
                <Icon size={17} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <div className="user-status">Supabase 已登录</div>
          <div className="user-email">{email ?? displayName}</div>
        </div>
      </aside>
      <main aria-label="评审工作区" className="main" id="dashboard-main" tabIndex={-1}>
        <header className="topbar">
          <div>
            <div className="eyebrow">内部评审</div>
            <h1>{title}</h1>
          </div>
          <div className="topbar-actions">
            <div className="time-chip" title="本地时间">
              <Clock3 size={15} />
              <span>{timeLabel}</span>
            </div>
            <button aria-label="刷新页面" className="icon-button" onClick={() => window.location.reload()} title="刷新" type="button">
              <RefreshCw size={18} />
            </button>
            <div className="account-card">
              <div className="account-avatar" aria-hidden="true">
                {safeAvatarUrl ? <img src={safeAvatarUrl} alt="" referrerPolicy="no-referrer" /> : <span>{initials}</span>}
              </div>
              <div className="account-copy">
                <strong>{displayName}</strong>
                {email && name ? <span>{email}</span> : <span>Supabase 账户</span>}
              </div>
              <button className="plain-button logout-button" onClick={onSignOut} type="button">
                <LogOut size={16} />
                <span>退出</span>
              </button>
            </div>
          </div>
        </header>
        {children}
      </main>
    </div>
  );
}
