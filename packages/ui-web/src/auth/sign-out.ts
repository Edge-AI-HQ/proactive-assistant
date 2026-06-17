/**
 * 清本地登录态并 reload 回入口（→ 登录页）。两个触发源共用同一实现：
 *   1. 用户主动 Sign Out（useAuth.signOut）。
 *   2. 传输层判定 session 不可恢复（transport-bootstrap 的 onAuthInvalid）——
 *      stale token + refresh 失败时自动收口，避免卡在「连不上服务器」错误屏。
 */
import { runSignOutCleanups } from "./auth-cleanup";
import { isPinLocalDevAuthEnabled } from "./dev-auth";
import { supabase } from "./supabase";

let signingOut = false;

/**
 * 按前缀清 Storage：先收集匹配 key 再删（边遍历边删会让 key(i) 索引移位）。
 * 用标准的 length + key(i) 而非 Object.keys(storage)——后者对 Storage 不可靠：
 * 它依赖宿主把每个 key 暴露成 own enumerable property（浏览器恰好如此，但非
 * 标准，基于 Map 的实现/stub 枚举不到，会静默清不掉）。
 */
function sweepStorage(storage: Storage, match: (key: string) => boolean): void {
  const stale: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key !== null && match(key)) stale.push(key);
  }
  for (const key of stale) storage.removeItem(key);
}

/**
 * 幂等：并发的多个 401 + 用户点击只执行一次（signingOut latch），否则会多次
 * reload。对失效 session 做到「一定清干净、一定 reload」：
 *   - supabase.auth.signOut() 在 token 已失效时可能 reject，try/catch 兜住，
 *     保证后续 reload 必然执行。
 *   - 额外手动清 `sb-*-auth-token`（supabase 持久化 session 的 key）兜底：万一
 *     signOut() 没清掉，reload 后也不会又把 stale session 读回来导致死循环。
 */
export async function performSignOut(): Promise<void> {
  if (signingOut) return;
  signingOut = true;

  sweepStorage(sessionStorage, (k) => k.startsWith("proactive-ai"));
  sweepStorage(
    localStorage,
    (k) => k.startsWith("pinai:") || (k.startsWith("sb-") && k.includes("-auth-token")),
  );

  // 平台注册的清理（frontend: clearDeviceCredentials；apps/web: 无）。
  try {
    await runSignOutCleanups();
  } catch {
    // 清理失败不阻断登出。
  }

  if (!isPinLocalDevAuthEnabled()) {
    try {
      await supabase.auth.signOut();
    } catch {
      // token 已失效时 signOut 可能 reject —— 本地态已清，继续 reload。
    }
  }

  // MemoryRouter（native）下 URL 恒为入口路径，reload 即「回根并清状态」；
  // replace("/") 在 Electron 的 pinai:// scheme 下会跳出 app 根，不可用。
  window.location.reload();
}
