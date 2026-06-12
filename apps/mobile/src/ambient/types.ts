/**
 * RN ambient 采集的共用形状——与 web（services/ambient/sources/types.ts +
 * lib/devices.ts）同协议：PersonalSignalInput 的 wire 字段、kind 常量、
 * AmbientSource 接口一字不差，后端 ingest/normalize 管道无感知客户端差异。
 */
export interface PersonalSignalInput {
  id?: string;
  source?: string;
  kind: string;
  sync_mode?: "incremental" | "full";
  title: string;
  summary: string;
  payload?: Record<string, unknown>;
  occurred_at?: string;
  available_at?: string;
  expires_at?: string;
  salience?: number;
  confidence?: number;
  dedupe_key?: string;
}

/** 与 web services/ambient/kinds.ts 对齐（只列 RN 已实现的源）。 */
export const SIGNAL_KINDS = {
  location: "device.location",
  calendarEvent: "device.calendar_event",
  deviceState: "device.device_state",
  visit: "device.visit",
  activity: "device.activity",
} as const;

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
