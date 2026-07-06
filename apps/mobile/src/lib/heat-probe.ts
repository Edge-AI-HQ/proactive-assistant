/**
 * __HEAT_PROBE__ 临时发热探针(排查完成后整体删除:本文件 + 全部带
 * __HEAT_PROBE__ 注释的调用点 + DebugPanel 的 Heat Probe 区块)。
 *
 * 用途:Release 真机看不到 Metro console,把关键"功耗状态"收进内存,
 * DebugPanel 打开时轮询展示——采集在不在跑 / 视频在不在播 / 动画门控
 * 翻转 / 渲染计数 / watchdog 心跳,用来把发热定量归因到具体子系统。
 *
 * 设计约束:写入 O(1)(Map.set / 数字自增),不 setState、不落盘、不上传、
 * 无订阅风暴(DebugPanel 打开时 1s 轮询快照,平时零消费)。gauge 变化才
 * 记 transition + console.info,counter 静默累加。
 */
import { AppState } from "react-native";

export interface HeatProbeTransition {
  at: number;
  key: string;
  value: string;
}

const bootAt = Date.now();
const gauges = new Map<string, string>();
const counters = new Map<string, number>();
const transitions: HeatProbeTransition[] = [];
const MAX_TRANSITIONS = 40;

/** gauge:状态量(on/off/playing/paused...)。值变化才记 transition + log。 */
export function probeSet(key: string, value: string | number | boolean): void {
  const v = String(value);
  if (gauges.get(key) === v) return;
  gauges.set(key, v);
  transitions.push({ at: Date.now(), key, value: v });
  if (transitions.length > MAX_TRANSITIONS) transitions.shift();
  console.info(`[heat-probe] ${key} → ${v}`);
}

/** counter:次数(渲染/轮询 tick/watchdog 心跳)。静默累加,面板里看增速。 */
export function probeCount(key: string, delta = 1): void {
  counters.set(key, (counters.get(key) ?? 0) + delta);
}

export interface HeatProbeSnapshot {
  uptimeSec: number;
  gauges: Array<[string, string]>;
  counters: Array<[string, number]>;
  transitions: HeatProbeTransition[];
}

export function heatProbeSnapshot(): HeatProbeSnapshot {
  return {
    uptimeSec: Math.round((Date.now() - bootAt) / 1000),
    gauges: [...gauges.entries()].sort(([a], [b]) => a.localeCompare(b)),
    counters: [...counters.entries()].sort(([a], [b]) => a.localeCompare(b)),
    transitions: [...transitions].reverse(),
  };
}

// app 前后台状态自采(息屏热排查的时间轴锚点)。
probeSet("app.state", AppState.currentState ?? "unknown");
AppState.addEventListener("change", (state) => probeSet("app.state", state));
