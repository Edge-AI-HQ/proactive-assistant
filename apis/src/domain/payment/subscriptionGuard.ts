import { db } from "./db.js";
import { isSubscriptionActiveForService } from "./subscriptionPolicy.js";

/**
 * 判断用户当前是否应享受服务（可进 Gateway、可启动/使用容器）。
 * 按「当前时间落在的周期」判定，与定时任务一致。
 */
export async function hasActiveSubscriptionForService(
  supabaseUserId: string,
): Promise<boolean> {
  const current = await db.getCurrentPeriodBySupabaseId(supabaseUserId);
  return isSubscriptionActiveForService(current);
}
