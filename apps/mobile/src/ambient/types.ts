/**
 * RN ambient 采集的共用形状。wire 协议（PersonalSignalInput / SIGNAL_KINDS）
 * 现在从 @pin-ai/core 取——三端 SSOT，不再各端手抄（旧版本 RN 把
 * SIGNAL_KINDS 缩成 5-key 子集，已是漂移开端）。SourceContext / AmbientSource
 * 是 RN 采集层的本地接口（与 web sources/types.ts 形状不同），各端自留。
 */
import type { PersonalSignalInput, SignalKind } from "@pin-ai/core";

export { SIGNAL_KINDS } from "@pin-ai/core";
export type { PersonalSignalInput, SignalKind };

export interface SourceContext {
  push: (item: PersonalSignalInput) => void;
  onEvent: (sourceKey: string, summary: string) => void;
}

export interface AmbientSource {
  readonly key: string;
  readonly label: string;
  isStarted(): boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** 周期源（calendar 扫描类）的手动刷新钩子。 */
  refresh?(): Promise<void>;
}
