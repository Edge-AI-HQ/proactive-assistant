/**
 * 遮盖信号（WS6 省电）：主壳被上层面板遮住时置 true——chat / card-chat 全屏 sheet,
 * 以及 debug 侧板（⚠️ 只盖 340pt 宽,不是严格"全屏":它的毛玻璃罩在动视频上会逐帧
 * 重采样,开着面板测发热会自热,2026-07-05 刻意纳入)。消费方据此停掉"被盖住时纯属
 * 浪费"的持续开销:VideoBackdrop 暂停视频解码、AskPinAiBar chevron / NowScreen
 * BreatheHalo / AmbientScreen PingRing 与遥测订阅停帧/退订。
 *
 * 用极简订阅 store + useSyncExternalStore,而不是把 AppShell 的状态一路 prop-drill
 * 到不同子树的消费者。AppShell 是唯一写入方。
 */
import { useSyncExternalStore } from "react";

let covered = false;
const listeners = new Set<() => void>();

export function setFullCover(next: boolean): void {
  if (covered === next) return;
  covered = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useFullCover(): boolean {
  return useSyncExternalStore(subscribe, () => covered);
}
