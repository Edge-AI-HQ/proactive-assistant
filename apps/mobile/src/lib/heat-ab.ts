/**
 * __HEAT_AB__ 临时发热对照开关(定位完成后整体删除:本文件 + VideoBackdrop /
 * AiSphere 里带 __HEAT_AB__ 注释的分支 + DebugPanel 的 HEAT A/B 区块)。
 *
 * 目的:一个 build 里实时切换渲染变体,在同一散热基线下真机对比发热,把 GPU
 * 大头定位到具体子系统——backdrop 视频 / sphere 混合(mixBlendMode) / sphere
 * 遮罩(MaskedView),不用为每个变体各出一个 build(避免两次 build 间机身基础
 * 温度漂移污染对比)。默认全 true = 当前线上行为。
 *
 * 用 useSyncExternalStore + 极简订阅 store(同 lib/full-cover 范式),DebugPanel
 * 是唯一写入方,VideoBackdrop / AiSphere 是消费者,跨子树无需 prop-drill。
 */
import { useSyncExternalStore } from "react";

export interface HeatAbFlags {
  /** false → 背景换静态 bg-gradient.jpg + 暂停视频解码。 */
  backdropVideo: boolean;
  /** false → sphere 去 mixBlendMode:"multiply"(退化为 normal)。 */
  sphereBlend: boolean;
  /** false → sphere 去 MaskedView 径向羽化(退化为硬边圆 borderRadius+overflow)。 */
  sphereMask: boolean;
  /** true → NOW 漂浮卡片走 Skia GPU 渲染(缓存贴图版);false = 原生 SphereCards。 */
  cardsSkia: boolean;
}

let flags: HeatAbFlags = {
  backdropVideo: true,
  sphereBlend: true,
  sphereMask: true,
  // 默认走混合渲染(Skia 影子 + 原生卡,凉且视觉已验收)——进 app 即此模式。
  // debug「Cards engine」仍可切 native 做 A/B。收尾批会删开关、把混合硬编成唯一渲染。
  cardsSkia: true,
};
const listeners = new Set<() => void>();

export function setHeatAbFlag<K extends keyof HeatAbFlags>(key: K, value: HeatAbFlags[K]): void {
  if (flags[key] === value) return;
  flags = { ...flags, [key]: value };
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useHeatAbFlags(): HeatAbFlags {
  return useSyncExternalStore(subscribe, () => flags);
}
