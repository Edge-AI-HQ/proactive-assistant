/**
 * signOut 时的平台清理注入点（各 app composition root 注册）。平台无关,web/RN 共用。
 *
 * 通用 signOut 只做平台无关清理;带 native 依赖的清理(如 secure storage / device
 * token 清除)由各 app 入口在 boot 时注册进来,core/ui 不直接依赖重 native 模块。
 * web 注册点见 proactive-ai-frontend / apps-web,RN 见 apps/mobile App.tsx。
 */
export type SignOutCleanup = () => void | Promise<void>;

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
