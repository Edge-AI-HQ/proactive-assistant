/**
 * ambient-models (Expo 本地模块) JS 绑定：端侧模型管理（whisper.cpp ASR + llama.cpp LLM
 * 的 下载 / 校验 / 删除 / 列表 / 推理）。Swift 核心从 capacitor-plugins/ambient-ai 移植
 * （ModelStore / ModelDownloader / ModelVerifier / LlamaTextGenerationEngine / ModelManifest，
 * 5 文件零改动复制；桥接 AmbientModelsModule.swift 重写为 ExpoModulesCore Module）。
 * 类型与方法面逐字对齐原 Capacitor ModelsNamespace（facade/types.ts），双端契约一致。
 *
 * 端侧 LLM 推理经 #if canImport(LlamaSwift) 条件编译：未接 llama 时 download/verify/delete/list
 * 全功能，generate* 抛 unavailable（接线见 Milestone C）。
 */
import { requireOptionalNativeModule, type EventSubscription } from "expo-modules-core";

export type ModelKind = "asr" | "llm";
export type ModelMirror = "hf" | "hf-mirror";
export type ModelMagic = "GGUF" | "ggml";
export type ModelDownloadState =
  | "absent"
  | "downloading"
  | "paused"
  | "present"
  | "verifying"
  | "failed";
export type ModelVerifyState = "ok" | "fail";

export interface ModelProfile {
  id: string;
  kind: ModelKind;
  displayName: string;
  repo: string;
  file: string;
  approxBytes: number;
  magic: ModelMagic;
  notes?: string;
}

export interface ModelDownloadStatus {
  id: string;
  state: ModelDownloadState;
  bytesWritten: number;
  bytesTotal: number;
  errorMessage?: string;
  mirrorInUse?: ModelMirror;
  sizeOnDisk?: number;
  lastVerifiedAt?: number;
  lastVerifyResult?: ModelVerifyState;
  lastVerifyOutput?: string;
  lastVerifyError?: string;
}

export interface ModelDownloadOptions {
  id: string;
  preferredMirror?: ModelMirror;
}

export interface ModelVerifyResult {
  id: string;
  ok: boolean;
  elapsedMs: number;
  output?: string;
  errorMessage?: string;
}

export interface ModelListResult {
  profiles: ModelProfile[];
  statuses: ModelDownloadStatus[];
}

export interface ModelDownloadProgressEvent extends ModelDownloadStatus {
  /** 事件发出时的服务器墙钟（ms）。 */
  emittedAt: number;
}

// ── LLM 生成相关（generate*；④ 面板不用，③ 时间线消费，纳入契约保证不阉割）──

export interface AmbientCandidateWindowForModel {
  id: string;
  localDate: string;
  timezone: string;
  windowType: string;
  startedAt: string;
  endedAt?: string;
  sourceTypes: string[];
  deviceLabels: string[];
  compactContext: string;
  privacyHint: "normal" | "private" | "sensitive";
  confidenceHint: number;
  salienceHint: number;
  schemaVersion: "ambient_candidate_window.v1";
}

export interface AmbientTimelineEventDraftResult {
  eventType: string;
  title: string;
  summary: string;
  tags: string[];
  confidence: number;
  confidenceLabel: "certain" | "uncertain";
  salientFacts: string[];
  actionCandidates?: unknown[];
  memoryCandidates?: string[];
  possibleCardTrigger?: { title: string; reason: string };
}

export interface GenerateTimelineEventOptions {
  modelId: string;
  /** core modelWindowPayload 构造的 JSON 载荷（形如 AmbientCandidateWindowForModel），原样转给 native。 */
  window: Record<string, unknown>;
}

export interface AmbientTimelineBatchInput {
  schemaVersion: "ambient_timeline_batch.v1";
  windows: AmbientCandidateWindowForModel[];
  recentLlmCards?: Array<Record<string, unknown>>;
  ruleContext?: Array<Record<string, unknown>>;
}

export interface GenerateTimelineBatchDecisionOptions {
  modelId: string;
  /** core modelBatchPayload 构造的 JSON 载荷（形如 AmbientTimelineBatchInput），原样转给 native。 */
  batch: Record<string, unknown>;
}

export interface AmbientTimelineBatchDecisionResult {
  decisions: unknown[];
}

interface AmbientModelsModuleType {
  listModels(): Promise<ModelListResult>;
  startModelDownload(options: ModelDownloadOptions): Promise<void>;
  cancelModelDownload(options: { id: string }): Promise<void>;
  deleteModel(options: { id: string }): Promise<void>;
  verifyModel(options: { id: string }): Promise<ModelVerifyResult>;
  generateTimelineEvent(
    options: GenerateTimelineEventOptions,
  ): Promise<AmbientTimelineEventDraftResult>;
  generateTimelineBatchDecision(
    options: GenerateTimelineBatchDecisionOptions,
  ): Promise<AmbientTimelineBatchDecisionResult>;
  addListener(
    eventName: "modelDownloadProgress" | "modelDownloadDone",
    listener: (event: ModelDownloadProgressEvent) => void,
  ): EventSubscription;
}

// native 未链入时（如未 rebuild / Swift core 未编译）给出清晰报错而非静默 undefined。
export const AmbientModels =
  requireOptionalNativeModule<AmbientModelsModuleType>("AmbientModels") ??
  (new Proxy(
    {},
    {
      get(_t, prop) {
        throw new Error(
          `AmbientModels native module unavailable (Swift core not linked in this build): ${String(prop)}`,
        );
      },
    },
  ) as AmbientModelsModuleType);
