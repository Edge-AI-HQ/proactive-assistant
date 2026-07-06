/**
 * 清本地登录态回登录页（dev `packages/ui-web/src/auth/sign-out.ts` 的 RN 版）。
 * 两个触发源共用同一实现：
 *   1. 用户主动 Sign Out（useAuth.signOut）。
 *   2. 传输层判定 session 不可恢复（transport-bootstrap 的 onAuthInvalid）——
 *      stale token + refresh 失败时自动收口，避免卡在「连不上服务器」错误屏。
 *
 * 与 web 版的介质差异：web 靠 full reload 清运行时态（sync/ambient/TQ 缓存
 * 随页面一起死），RN 无 reload——这里显式逐项停机；storage sweep 从
 * localStorage 换 AsyncStorage（同一批 key 前缀）。清完不做导航：supabase
 * signOut 发 SIGNED_OUT → useAuth 置 user=null → App 渲染 LoginScreen，
 * 回登录页由 auth 状态自然驱动。
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { runSignOutCleanups } from "@pin-ai/core";

import { clearAmbientLiveTranscript } from "../ambient/live/live-transcript-store";
import { stopAmbient } from "../ambient/runtime";
import { resetAmbientTimelineStore } from "../ambient/timeline";
import { isPinLocalDevAuthEnabled } from "./dev-auth";
import { queryClient } from "./query-client";
import { supabase } from "./supabase";
import { stopSync } from "./sync/sync-bootstrap";

let signOutPromise: Promise<void> | null = null;

/** 按前缀清 AsyncStorage（dev sweepStorage 的 RN 版，同一批 key）：
 *  `pinai:*`（TQ persister 缓存等）+ `sb-*-auth-token`（supabase 持久化
 *  session）。先删 session 再调 signOut 是 dev 同款兜底：即使 signOut 因
 *  网络失败，下次冷启也不会把 stale session 读回来；且 signOut 读不到
 *  session 会跳过服务端调用、必发 SIGNED_OUT（auth-js 每次从 storage 读）。 */
async function sweepAsyncStorage(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const stale = keys.filter(
      (k) => k.startsWith("pinai:") || (k.startsWith("sb-") && k.includes("-auth-token")),
    );
    if (stale.length > 0) await AsyncStorage.multiRemove(stale);
  } catch {
    // sweep 失败不阻断登出。
  }
}

/**
 * 幂等：并发的多个 401 + 用户点击共享同一次执行（in-flight promise 单飞）。
 * 完成后释放 latch——RN 没有 reload，同一 JS 进程里下次登录后还要能再登出
 * （dev 的 signingOut 布尔闸不复位，靠 reload 重置模块态）。
 */
export async function performSignOut(): Promise<void> {
  if (signOutPromise) return signOutPromise;
  signOutPromise = (async () => {
    // 先停后台写者（web 版这两步由 reload 承担）：sync 兜底轮询 + ambient 采集。
    stopSync();
    try {
      await stopAmbient();
    } catch {
      // 停采失败不阻断登出。
    }
    // 清本地 ambient 数据（跨账号隐私）：停采后再清，避开采集写入竞态。时间线
    // durable SQLite + 实时转写内存态都是 device-global，登出必清，否则下个账号
    // 能看到上个账号的时间线/转录（dev native 有同样潜在泄露，见 reset-sqlite.ts）。
    try {
      await resetAmbientTimelineStore();
    } catch {
      // 清时间线失败不阻断登出。
    }
    clearAmbientLiveTranscript();

    await sweepAsyncStorage();

    // 平台注册的清理（App.tsx: clearDeviceCredentials 等）。
    try {
      await runSignOutCleanups();
    } catch {
      // 清理失败不阻断登出。
    }

    if (!isPinLocalDevAuthEnabled()) {
      try {
        await supabase.auth.signOut();
      } catch {
        // token 已失效时 signOut 可能 reject——本地态已清（上面 sweep），
        // 下次冷启读不到 session，不会死循环。
      }
    }

    // web 版由 reload 顺带清内存缓存；RN 显式清（SIGNED_OUT 后 LoginScreen
    // 渲染，登录态 hooks 均已 disable，无消费者）。
    queryClient.clear();
  })().finally(() => {
    signOutPromise = null;
  });
  return signOutPromise;
}
