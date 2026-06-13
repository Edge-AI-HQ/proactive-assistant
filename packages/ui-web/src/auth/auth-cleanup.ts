/**
 * signOut 时的平台清理注入点（composition root 注册）。
 *
 * useAuth.signOut 只做 web 介质通用的清理（storage sweep + supabase
 * signOut）；带 native 依赖的清理（如 proactive-ai-frontend 的
 * clearDeviceCredentials —— secure storage / device token）由各 app 入口
 * 在 boot 时注册进来，ui-web 不直接依赖重 native 模块。
 */
type SignOutCleanup = () => void | Promise<void>;

const cleanups: SignOutCleanup[] = [];

export function registerSignOutCleanup(fn: SignOutCleanup): void {
  cleanups.push(fn);
}

export async function runSignOutCleanups(): Promise<void> {
  for (const fn of cleanups) {
    try {
      await fn();
    } catch (err) {
      console.warn("[auth] signOut cleanup failed:", err);
    }
  }
}
