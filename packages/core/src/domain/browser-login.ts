/**
 * Browser login registry —— agent 浏览器里"用户登录过的网站"。平台无关类型。
 *
 * 登录态(cookie)存在用户的持久 Browserbase Context 里,不在我们 DB;这里只
 * 镜像后端 pai_browser_logins 的元数据(哪些站登过 + 状态),给 data connector
 * UI 列表 + 删除用。后端契约见 web/routes/ui/browser.py 的 /logins endpoints。
 */

export type BrowserLoginStatus = "active" | "expired";

export interface BrowserLogin {
  siteDomain: string;
  displayName: string | null;
  loginLabel: string | null;
  status: BrowserLoginStatus;
  lastUsedAt: string | null;
}

export function parseBrowserLoginStatus(value: unknown): BrowserLoginStatus {
  return value === "expired" ? "expired" : "active";
}

/** 后端 /logins item → BrowserLogin(防御 unknown JSON;缺 siteDomain 丢弃)。 */
export function normalizeBrowserLogin(raw: unknown): BrowserLogin | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const siteDomain = typeof r.siteDomain === "string" ? r.siteDomain : "";
  if (!siteDomain) return null;
  return {
    siteDomain,
    displayName: typeof r.displayName === "string" ? r.displayName : null,
    loginLabel: typeof r.loginLabel === "string" ? r.loginLabel : null,
    status: parseBrowserLoginStatus(r.status),
    lastUsedAt: typeof r.lastUsedAt === "string" ? r.lastUsedAt : null,
  };
}

/** URL / host 字符串 → 裸 host(小写,去 scheme/path/port)。非真实 host
 *  (about:blank / chrome:// / 无点号)返回 null —— 不当成可登录的站记录。 */
export function hostFromUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  let s = value.trim().toLowerCase();
  if (!s) return null;
  if (s.includes("://")) s = s.split("://", 2)[1] ?? "";
  s = s.split("/", 1)[0] ?? "";
  s = s.split(":", 1)[0] ?? "";
  if (!s || !s.includes(".")) return null;
  return s;
}
