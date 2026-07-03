/**
 * Sound-classifier 源（Swift 保留件：SoundAnalysis + 采集管道经
 * ambient-audio Expo module）。覆盖：分类事件（低置信过滤 + 同标签折叠）、
 * speech burst、转写（实时事件 + 启动/refresh 时 drain 积压 + recent capture
 * 扫描补录）、可重入 refresh() 健康自愈（watchdog 每 60s 调）——对齐 dev
 * services/ambient/sources/sound-classifier.ts。
 *
 * 转写清洗走 core cleanAmbientTranscriptText（无意义 burst 不显示不上传），
 * 转写失败 live 卡显示 "Transcription unavailable"（= dev :427-434）。
 */
import {
  SoundRunAggregator,
  cleanAmbientTranscriptText,
  getTransportConfig,
  fetchVoiceIdentity,
  normalizeVoiceLanguage,
  speakerAwareTranscriptText,
  type DiarizationStatus,
  type SpeakerSegment,
} from "@pin-ai/core";
import { EncodingType, File, Paths, UploadType } from "expo-file-system";
import {
  AmbientAudio,
  type AudioStateEvent,
  type CaptureReadyEvent,
  type SoundClassificationEvent,
  type SpeechBurstEvent,
  type TranscriptEvent,
} from "../../../modules/ambient-audio";
import { applyAmbientLiveTranscriptUpdate } from "../live/live-transcript-store";
import {
  type AmbientSource,
  type AmbientSourceStartOptions,
  type SourceContext,
} from "../types";

const SOUND_KIND = "device.sound_classification";
const TRANSCRIPT_KIND = "session_summary";
const MIN_CONFIDENCE = 0.55;
const TRANSCRIPT_SALIENCE = 0.7;
const TRANSCRIPT_CONFIDENCE = 0.75;
const SPEECH_LABEL = "speech";
const RECENT_CAPTURE_RECOVERY_BATCH_SIZE = 25;
const RECENT_CAPTURE_RECOVERY_MAX_PAGES = 20;
const RETRY_DELAYS_MS = [300, 1_000] as const;
// refresh() 健康检查阈值（dev sound-classifier.ts:52-54）。
const INTENTIONAL_SUPPRESSION_REASONS = new Set(["playback", "external_mic"]);
const UNHEALTHY_ENGINE_STATES = new Set(["failed", "stale", "suspended"]);
const CLASSIFICATION_STALE_MS = 15_000;

// 与 web LIVE_AUDIO_CONFIG 一致（分段节奏参数）。
const LIVE_AUDIO_CONFIG = {
  preRollMs: 2_000,
  postRollMs: 5_000,
  maxBurstMs: 20_000,
  minBurstMs: 1_000,
  sessionSilenceGapMs: 30_000,
  maxSessionDurationMs: 5 * 60_000,
} as const;

/** getState() 原生 payload 已带、TS 绑定未声明的诊断字段（真源
 *  modules/ambient-audio/ios/AudioCaptureModels.swift 的 payload）。 */
interface AudioStateDiagnostics extends AudioStateEvent {
  suppressedReason?: string;
  lastClassificationAt?: number;
}

// 转译结果（plain 或 diarized）。对齐 dev CaptureTranscriptionResult 的形状。
interface TranscriptResult {
  text: string;
  selfText: string;
  speakerLabels: string[];
  segments: SpeakerSegment[];
  provider: string;
  diarizationStatus: DiarizationStatus;
  diarizationModel?: "gpt-4o-transcribe-diarize";
}

function plainTranscriptResult(text: string, status: DiarizationStatus): TranscriptResult {
  return {
    text: text.trim(),
    selfText: "",
    speakerLabels: [],
    segments: [],
    provider: "cloud_whisper",
    diarizationStatus: status,
  };
}

/** SpeakerSegment[] → payload.speaker_segments 形状（snake_case，对齐 dev + core
 *  speakerAwareTranscriptText 读取的 start_ms/end_ms）。逐段过 core 清洗
 *  （dev sound-classifier.ts:486-495——脏段丢弃、干净段保留清洗后文本）。 */
function payloadSpeakerSegments(
  segments: SpeakerSegment[],
): Array<{ speaker: string; text: string; start_ms: number | null; end_ms: number | null }> {
  return segments.flatMap((segment) => {
    const text = cleanAmbientTranscriptText(segment.text);
    if (!text) return [];
    return [{ speaker: segment.speaker || "other", text, start_ms: segment.startMs, end_ms: segment.endMs }];
  });
}

export function createSoundClassifierSource(
  ctx: SourceContext,
  opts?: { getTranscriptionLanguage?: () => string | null },
): AmbientSource {
  let subs: { remove(): void }[] = [];
  let started = false;
  let lastLabel: string | null = null;
  const handledCaptureIds = new Set<string>();
  const inFlightCaptureIds = new Set<string>();
  // 已 push 过的转录 burst id（对齐 web storedTranscriptBurstIds，push 前预去重）。
  const storedTranscriptBurstIds = new Set<string>();
  const runs = new SoundRunAggregator();
  // run 生命周期（dev beginRun/endRun/isRunActive）：stop/restart 后到达的
  // 陈旧转写只更新 live 卡、不再 push 信号（防 outbox 重复）。
  let activeRunId: number | null = null;
  let nextRunId = 0;
  let recoveryRequestedWhileRunning = false;
  let pendingAudioRecovery: Promise<void> | null = null;

  // settings.generationLanguage → 语音语言 hint（dev voiceLanguage()：browser
  // locale 喂原生识别、openai code 拼 ?language= 给云转写）。
  function voiceLanguage() {
    return normalizeVoiceLanguage(opts?.getTranscriptionLanguage?.());
  }

  function transcriptionLanguage(): string | undefined {
    return voiceLanguage().openai;
  }

  function beginRun(): number {
    nextRunId += 1;
    activeRunId = nextRunId;
    recoveryRequestedWhileRunning = false;
    return activeRunId;
  }

  function endRun(): void {
    activeRunId = null;
    recoveryRequestedWhileRunning = false;
  }

  function isRunActive(runId: number): boolean {
    return started && activeRunId === runId;
  }

  function handleClassification(event: SoundClassificationEvent): void {
    const top = event.classifications?.[0];
    if (!top || top.confidence < MIN_CONFIDENCE) return;
    const timestamp = event.timestamp || Date.now();
    if (top.label.toLowerCase() !== SPEECH_LABEL) {
      const emitted = runs.addSample({
        timestamp,
        classifications: event.classifications.slice(0, 3).map((c) => ({
          label: c.label,
          confidence: c.confidence,
        })),
      });
      for (const item of emitted) {
        ctx.push(item);
        ctx.onEvent("sound_classifier", `${item.title} scene run`);
      }
    }
    if (top.label === lastLabel) return; // 同标签折叠（speech speech speech）
    lastLabel = top.label;
    const summary = `${top.label} (${Math.round(top.confidence * 100)}%)`;
    ctx.push({
      kind: SOUND_KIND,
      title: "Ambient sound",
      summary,
      occurred_at: new Date(timestamp).toISOString(),
      payload: {
        schema_version: "sound_classification.v1",
        classifications: event.classifications.slice(0, 3),
      },
    });
    ctx.onEvent("sound_classifier", summary);
  }

  function handleTranscript(event: TranscriptEvent, runId?: number): void {
    const dedupeId = event.burstId ?? event.wavId;
    const rawText = event.text?.trim();
    if (!rawText) {
      ctx.onEvent("sound_classifier", `discard:empty_text burst=${dedupeId}`);
      return;
    }
    // core 清洗（dev :322-329）：无意义 burst 不显示不上传，WAV 直接清理。
    const text = cleanAmbientTranscriptText(rawText);
    if (!text) {
      ctx.onEvent("sound_classifier", `discard:meaningless_text burst=${dedupeId}`);
      if (event.wavId && (!dedupeId || !inFlightCaptureIds.has(dedupeId))) {
        void markCaptureProcessed(event.wavId);
      }
      return;
    }
    // 预去重(对齐 web storedTranscriptBurstIds)：已 push 过的 burst 直接跳过，连 push 都不做。
    // outbox 的 dedupe_key 仍是正确性兜底；这里只提前一步省功，凑足与 web 逐字一致。
    if (dedupeId && storedTranscriptBurstIds.has(dedupeId)) {
      ctx.onEvent("sound_classifier", `discard:dedup_stored burst=${dedupeId}`);
      return;
    }
    // 信号 push 按 run 生命周期 gate（dev :349-352）：stop/restart 后 replay 的
    // 陈旧转写不再进 outbox（防重复）。
    if (runId !== undefined && !isRunActive(runId)) {
      ctx.onEvent("sound_classifier", `discard:runid_skip_signal burst=${dedupeId}`);
      return;
    }
    const occurredAt = transcriptOccurredAt(event);
    const captureSessionId = event.captureSessionId ?? event.sessionId;
    ctx.push({
      kind: TRANSCRIPT_KIND,
      title: "Voice summary",
      summary: text,
      occurred_at: occurredAt,
      salience: TRANSCRIPT_SALIENCE,
      confidence: TRANSCRIPT_CONFIDENCE,
      dedupe_key: dedupeId ? `ios:audio:${dedupeId}` : undefined,
      payload: {
        schema_version: "audio_transcript.v1",
        platform: event.platform ?? "ios",
        text,
        wavId: event.wavId,
        burstId: event.burstId,
        captureSessionId,
        durationMs: event.durationMs,
        provider: event.provider ?? "cloud_whisper",
        fallback: event.fallback ?? false,
        triggerSource: event.triggerSource,
        speaker_segments: [],
        speaker_labels: [],
        self_text: "",
        diarization_status: "fallback_plain_text",
        started_at: event.startedAt,
        ended_at: event.endedAt,
      },
    });
    if (dedupeId) storedTranscriptBurstIds.add(dedupeId);
    ctx.onEvent("sound_classifier", `transcript ${text.slice(0, 40)}`);
    if (event.wavId && (!dedupeId || !inFlightCaptureIds.has(dedupeId))) {
      void markCaptureProcessed(event.wavId);
    }
  }

  async function handleCaptureReady(event: CaptureReadyEvent, runId?: number): Promise<void> {
    const id = captureDedupeId(event);
    if (storedTranscriptBurstIds.has(id)) {
      ctx.onEvent("sound_classifier", `discard:dedup_stored burst=${id}`);
      return;
    }
    if (handledCaptureIds.has(id)) {
      ctx.onEvent("sound_classifier", `discard:dedup_handled burst=${id}`);
      return;
    }
    if (inFlightCaptureIds.has(id)) {
      ctx.onEvent("sound_classifier", `discard:dedup_inflight burst=${id}`);
      return;
    }
    ctx.onEvent("sound_classifier", `capture ready ${Math.round(event.durationMs / 1000)}s`);
    inFlightCaptureIds.add(id);
    try {
      const result = await transcribeCapture(event);
      const rawText = result.text.trim();
      if (!rawText) {
        handledCaptureIds.add(id);
        await markCaptureProcessed(event.wavId);
        return;
      }
      const text = cleanAmbientTranscriptText(rawText);
      if (!text) {
        handledCaptureIds.add(id);
        ctx.onEvent("sound_classifier", `discard:meaningless_text burst=${id}`);
        await markCaptureProcessed(event.wavId);
        return;
      }
      // 信号 push / WAV 清理 / handled 标记都按 run 生命周期 gate（dev :408-425）：
      // 陈旧 capture 不进 outbox、不删原生 WAV、不标 handled——留给下个 run 的
      // recovery 扫描。live 卡更新在 pushCaptureTranscript 内（按 captureSessionId
      // 路由，与 run 无关）。
      const runStillActive = runId === undefined || isRunActive(runId);
      if (runStillActive && !storedTranscriptBurstIds.has(id)) {
        handledCaptureIds.add(id);
        pushCaptureTranscript(event, result, text);
        await markCaptureProcessed(event.wavId);
      } else if (!runStillActive) {
        ctx.onEvent("sound_classifier", `discard:runid_skip_signal burst=${id}`);
      }
    } catch (err) {
      // 转写失败：live 卡占位 "Transcription unavailable"（dev :427-434）。
      const captureSessionId = event.captureSessionId ?? event.sessionId;
      if (event.burstId && captureSessionId) {
        applyAmbientLiveTranscriptUpdate({
          captureSessionId,
          id: event.burstId,
          text: "Transcription unavailable",
          source: "microphone",
          receivedAt: Date.now(),
        });
      }
      ctx.onEvent("sound_classifier", `Voice transcription failed: ${errorMessage(err)}`);
      if (storedTranscriptBurstIds.has(id)) {
        await markCaptureProcessed(event.wavId);
      }
    } finally {
      inFlightCaptureIds.delete(id);
    }
  }

  // 转译一段采集：voice identity 启用则走 diarized（分离 + 后端后处理），否则/失败退回 plain。
  // 对齐 dev transcribeAmbientCapture。
  async function transcribeCapture(event: CaptureReadyEvent): Promise<TranscriptResult> {
    const capture = await AmbientAudio.readCapture(event.wavId);
    const file = writeCaptureTempFile(capture);
    const language = transcriptionLanguage();
    try {
      let profileEnabled = false;
      let disabledStatus: DiarizationStatus = "not_enrolled";
      try {
        const profile = await fetchVoiceIdentity();
        profileEnabled = profile?.enabled === true;
        disabledStatus = profile ? "disabled" : "not_enrolled";
      } catch {
        profileEnabled = false;
        disabledStatus = "not_enrolled";
      }
      if (profileEnabled) {
        try {
          return await withTranscribeRetry(() =>
            transcribeVoiceFileDiarized(file, capture.contentType, { language }),
          );
        } catch {
          const text = await withTranscribeRetry(() =>
            transcribeVoiceFile(file, capture.contentType, { language }),
          );
          return plainTranscriptResult(text, "fallback_plain_text");
        }
      }
      const text = await withTranscribeRetry(() =>
        transcribeVoiceFile(file, capture.contentType, { language }),
      );
      return plainTranscriptResult(text, disabledStatus);
    } finally {
      try {
        file.delete();
      } catch {
        // Best-effort cache cleanup only.
      }
    }
  }

  // 建转写信号（含 diarized 载荷）+ 实时喂 live 卡。对齐 dev sound-classifier 的 push。
  // text = core 清洗后的文本（调用方已判空）。
  function pushCaptureTranscript(event: CaptureReadyEvent, result: TranscriptResult, text: string): void {
    const dedupeId = event.burstId ?? event.wavId;
    const speakerSegments = payloadSpeakerSegments(result.segments);
    const endMs = captureOccurredAtMs(event);
    const durationMs = Number.isFinite(event.durationMs) ? event.durationMs : undefined;
    const captureSessionId = event.captureSessionId ?? event.sessionId;
    if (event.burstId && captureSessionId) {
      applyAmbientLiveTranscriptUpdate({
        captureSessionId,
        id: event.burstId,
        text: speakerAwareTranscriptText(speakerSegments, text),
        source: result.provider,
        receivedAt: endMs,
      });
    }
    ctx.push({
      kind: TRANSCRIPT_KIND,
      title: "Voice summary",
      summary: text,
      occurred_at: new Date(endMs).toISOString(),
      salience: TRANSCRIPT_SALIENCE,
      confidence: TRANSCRIPT_CONFIDENCE,
      dedupe_key: dedupeId ? `ios:audio:${dedupeId}` : undefined,
      payload: {
        schema_version: "audio_transcript.v1",
        platform: event.platform ?? "ios",
        text,
        wavId: event.wavId,
        burstId: event.burstId,
        captureSessionId,
        durationMs,
        provider: result.provider,
        fallback: result.provider === "cloud_whisper",
        triggerSource: event.triggerSource,
        speaker_segments: speakerSegments,
        speaker_labels: result.speakerLabels,
        self_text: cleanAmbientTranscriptText(result.selfText) ?? "",
        diarization_status: result.diarizationStatus,
        ...(result.diarizationModel ? { diarization_model: result.diarizationModel } : {}),
        started_at: durationMs !== undefined ? endMs - durationMs : undefined,
        ended_at: endMs,
      },
    });
    if (dedupeId) storedTranscriptBurstIds.add(dedupeId);
    ctx.onEvent("sound_classifier", `transcript ${text.slice(0, 40)}`);
  }

  async function markCaptureProcessed(wavId: string): Promise<void> {
    try {
      await AmbientAudio.markCaptureProcessed(wavId);
    } catch (error) {
      ctx.onEvent("sound_classifier", `Processed capture cleanup failed: ${errorMessage(error)}`);
    }
  }

  // ── pending audio recovery（dev :211-297）：drain 原生积压转写 + 扫描
  // 未处理的 recent captures 补转写。start / refresh 后跑；同一时间只跑一个
  // loop，期间再请求则排队一轮。 ──

  function schedulePendingAudioRecovery(reason: string): void {
    const runId = activeRunId;
    if (runId === null) return;
    if (pendingAudioRecovery) {
      recoveryRequestedWhileRunning = true;
      return;
    }
    pendingAudioRecovery = recoverPendingAudioLoop(runId, reason)
      .catch((error) => {
        ctx.onEvent("sound_classifier", `Pending audio recovery failed: ${errorMessage(error)}`);
      })
      .finally(() => {
        pendingAudioRecovery = null;
      });
    void pendingAudioRecovery;
  }

  async function recoverPendingAudioLoop(runId: number, reason: string): Promise<void> {
    let currentReason = reason;
    do {
      recoveryRequestedWhileRunning = false;
      if (!isRunActive(runId)) return;
      await recoverPendingAudio(runId, currentReason);
      currentReason = "queuedRefresh";
    } while (recoveryRequestedWhileRunning && isRunActive(runId));
  }

  async function recoverPendingAudio(runId: number, reason: string): Promise<void> {
    await drainPendingNativeTranscripts(runId);
    if (!isRunActive(runId)) return;
    await transcribeUnhandledRecentCaptures(runId);
    if (!isRunActive(runId)) return;
    ctx.onEvent("sound_classifier", `Recovered pending audio after ${reason}`);
  }

  async function drainPendingNativeTranscripts(runId: number): Promise<void> {
    let transcripts: TranscriptEvent[];
    try {
      ({ transcripts } = await AmbientAudio.drainPendingTranscripts());
    } catch (error) {
      ctx.onEvent("sound_classifier", `Pending transcript drain failed: ${errorMessage(error)}`);
      return;
    }
    if (!isRunActive(runId)) return;
    for (const event of transcripts) {
      if (!isRunActive(runId)) return;
      handleTranscript(event, runId);
    }
  }

  async function transcribeUnhandledRecentCaptures(runId: number): Promise<void> {
    let cursor: string | null = null;
    for (let page = 0; page < RECENT_CAPTURE_RECOVERY_MAX_PAGES; page += 1) {
      let captures: CaptureReadyEvent[];
      try {
        ({ captures } = await AmbientAudio.listRecentCaptures(
          RECENT_CAPTURE_RECOVERY_BATCH_SIZE,
          cursor,
          "desc",
        ));
      } catch (error) {
        ctx.onEvent("sound_classifier", `Recent capture scan failed: ${errorMessage(error)}`);
        return;
      }
      if (!isRunActive(runId) || captures.length === 0) return;
      for (const capture of captures) {
        if (!isRunActive(runId)) return;
        if (!capture.burstId || !capture.captureSessionId) continue;
        if (storedTranscriptBurstIds.has(capture.burstId)) continue;
        if (handledCaptureIds.has(capture.burstId)) continue;
        if (inFlightCaptureIds.has(capture.burstId)) continue;
        await handleCaptureReady({ ...capture, triggerSource: "recent_capture_scan" }, runId);
      }
      if (captures.length < RECENT_CAPTURE_RECOVERY_BATCH_SIZE) return;
      cursor = captures[captures.length - 1]?.capturedAt ?? null;
      if (!cursor) return;
    }
  }

  async function getAudioStateDiagnostics(): Promise<AudioStateDiagnostics> {
    // 原生 snapshot payload 带 suppressedReason / lastClassificationAt，TS 绑定
    // （modules/ambient-audio/index.ts）未声明——本地扩展类型收窄，不动模块绑定。
    return (await AmbientAudio.getState()) as AudioStateDiagnostics;
  }

  async function cleanupNativeStartFailure(): Promise<void> {
    await Promise.allSettled([
      AmbientAudio.stopClassification(),
      AmbientAudio.stopCapture(),
    ]);
    for (const s of subs) s.remove();
    subs = [];
    started = false;
  }

  function handleSpeechBurst(event: SpeechBurstEvent): void {
    ctx.onEvent("sound_classifier", `speech burst ${Math.round(event.durationMs / 1000)}s`);
  }

  return {
    key: "sound_classifier",
    label: "Ambient audio",
    isStarted: () => started,
    async start(options?: AmbientSourceStartOptions) {
      if (started) return;
      const perm =
        options?.interactivePermissions === false
          ? await AmbientAudio.checkPermissions()
          : await AmbientAudio.requestPermissions();
      if (perm.microphone !== "granted") throw new Error("microphone permission denied");
      await AmbientAudio.configure({
        ...LIVE_AUDIO_CONFIG,
        recognitionLocale: voiceLanguage().browser,
      });
      let runId: number | null = null;
      try {
        subs = [
          AmbientAudio.addListener("soundClassification", handleClassification),
          AmbientAudio.addListener("captureReady", (event: CaptureReadyEvent) => {
            void handleCaptureReady(event, activeRunId ?? undefined);
          }),
          AmbientAudio.addListener("transcript", (event: TranscriptEvent) => {
            handleTranscript(event, activeRunId ?? undefined);
          }),
          AmbientAudio.addListener("speechBurst", handleSpeechBurst),
          AmbientAudio.addListener("audioError", (e: { message: string; source: string }) =>
            console.warn(`[ambient:audio] error ${e.source}: ${e.message}`),
          ),
        ];
        runId = beginRun();
        await AmbientAudio.startCapture();
        await AmbientAudio.startClassification();
        started = true;
        // 上次后台/停摆攒下的积压（原生 pending 转写 + 未处理 capture）。
        schedulePendingAudioRecovery("start");
      } catch (err) {
        if (runId !== null && activeRunId === runId) activeRunId = null;
        await cleanupNativeStartFailure();
        throw err;
      }
    },
    async stop() {
      endRun();
      try {
        await AmbientAudio.stopClassification().catch(() => {});
        await AmbientAudio.stopCapture().catch(() => {});
      } finally {
        for (const s of subs) s.remove();
        subs = [];
        const finalized = runs.stop();
        if (finalized) ctx.push(finalized);
        started = false;
        lastLabel = null;
        inFlightCaptureIds.clear();
      }
    },
    /**
     * 可重入健康自愈（dev refresh():154-205，watchdog 每 60s 调）：
     * 刻意抑制（playback / external_mic）→ 只补扫积压；全健康 → 补扫积压；
     * engine failed/stale/suspended、分类 15s 停更、错过 interruption-ended →
     * startCapture/startClassification 复活，再验一次，不健康则抛错进遥测。
     */
    async refresh() {
      if (!started) return;

      const state = await getAudioStateDiagnostics();
      if (
        state.suppressed &&
        state.suppressedReason &&
        INTENTIONAL_SUPPRESSION_REASONS.has(state.suppressedReason)
      ) {
        schedulePendingAudioRecovery("refreshSuppressed");
        return;
      }

      const analyzerUnhealthy = UNHEALTHY_ENGINE_STATES.has(state.engineState);
      const classificationsStale = isClassificationStale(state.lastClassificationAt);
      if (
        state.running
        && state.classificationRunning
        && state.engineRunning !== false
        && !analyzerUnhealthy
        && !classificationsStale
      ) {
        schedulePendingAudioRecovery("refreshHealthy");
        return;
      }

      if (!state.running || state.engineRunning === false || analyzerUnhealthy || classificationsStale) {
        await AmbientAudio.startCapture();
      }
      if (!state.classificationRunning || state.engineRunning === false || analyzerUnhealthy || classificationsStale) {
        await AmbientAudio.startClassification();
      }

      const nextState = await getAudioStateDiagnostics();
      if (!nextState.running) {
        throw new Error("audio capture not running");
      }
      if (!nextState.classificationRunning) {
        throw new Error("sound classification not running");
      }
      if (nextState.engineRunning === false && !nextState.suppressed) {
        throw new Error("sound classifier engine not running");
      }
      if (nextState.engineState && UNHEALTHY_ENGINE_STATES.has(nextState.engineState)) {
        throw new Error(`sound classifier engine ${nextState.engineState}`);
      }
      if (isClassificationStale(nextState.lastClassificationAt)) {
        throw new Error("sound classifier classifications stale");
      }
      schedulePendingAudioRecovery("refreshRecovered");
    },
  };
}

function isClassificationStale(lastClassificationAt: number | undefined): boolean {
  return typeof lastClassificationAt === "number"
    && Date.now() - lastClassificationAt > CLASSIFICATION_STALE_MS;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function transcribeVoiceFile(
  file: File,
  contentType: string,
  options: { language?: string } = {},
): Promise<string> {
  const params = new URLSearchParams();
  if (options.language) params.set("language", options.language);
  const path = `/voice/transcribe${params.size > 0 ? `?${params.toString()}` : ""}`;
  const cfg = getTransportConfig();
  const headers = {
    ...(cfg.defaultHeaders ?? {}),
    ...(await cfg.getAuthHeaders()),
    "Content-Type": contentType || "audio/wav",
    "X-Audio-Filename": filenameForContentType(contentType),
  };
  let result = await uploadVoiceFile(file, `${cfg.baseUrl}/api${path}`, headers, contentType);
  if (result.status === 401 && cfg.refreshAuth) {
    const token = await cfg.refreshAuth();
    if (token) {
      result = await uploadVoiceFile(
        file,
        `${cfg.baseUrl}/api${path}`,
        { ...headers, Authorization: `Bearer ${token}` },
        contentType,
      );
    }
  }
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`/voice/transcribe failed: ${result.status} ${result.body}`);
  }
  const data = JSON.parse(result.body) as { text?: unknown };
  if (typeof data.text !== "string") {
    throw new Error("/voice/transcribe response missing text");
  }
  return data.text.trim();
}

/** diarized 转译（说话人分离 + 后端 gpt-5-nano 后处理）——对齐 dev transcribeVoiceAudioDiarized，
 *  但走 RN 的原生文件上传（core 版吃 Blob，RN fetch 不可靠）。响应解析复制 core normalizeSegments。 */
async function transcribeVoiceFileDiarized(
  file: File,
  contentType: string,
  options: { language?: string } = {},
): Promise<TranscriptResult> {
  const params = new URLSearchParams();
  if (options.language) params.set("language", options.language);
  const path = `/voice/transcribe-diarized${params.size > 0 ? `?${params.toString()}` : ""}`;
  const cfg = getTransportConfig();
  const headers = {
    ...(cfg.defaultHeaders ?? {}),
    ...(await cfg.getAuthHeaders()),
    "Content-Type": contentType || "audio/wav",
    "X-Audio-Filename": filenameForContentType(contentType),
  };
  let result = await uploadVoiceFile(file, `${cfg.baseUrl}/api${path}`, headers, contentType);
  if (result.status === 401 && cfg.refreshAuth) {
    const token = await cfg.refreshAuth();
    if (token) {
      result = await uploadVoiceFile(
        file,
        `${cfg.baseUrl}/api${path}`,
        { ...headers, Authorization: `Bearer ${token}` },
        contentType,
      );
    }
  }
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`/voice/transcribe-diarized failed: ${result.status} ${result.body}`);
  }
  const data = JSON.parse(result.body) as {
    text?: unknown;
    selfText?: unknown;
    speakerLabels?: unknown;
    segments?: unknown;
    diarizationStatus?: unknown;
  };
  if (typeof data.text !== "string") {
    throw new Error("/voice/transcribe-diarized response missing text");
  }
  return {
    text: data.text.trim(),
    selfText: typeof data.selfText === "string" ? data.selfText.trim() : "",
    speakerLabels: Array.isArray(data.speakerLabels)
      ? data.speakerLabels.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      : [],
    segments: normalizeDiarizeSegments(data.segments),
    provider: "cloud_diarize",
    diarizationStatus: normalizeDiarizationStatus(data.diarizationStatus),
    diarizationModel: "gpt-4o-transcribe-diarize",
  };
}

function normalizeDiarizeSegments(value: unknown): SpeakerSegment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): SpeakerSegment[] => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (typeof row.text !== "string" || !row.text.trim()) return [];
    return [{
      speaker: typeof row.speaker === "string" && row.speaker.trim() ? row.speaker.trim() : "other",
      text: row.text.trim(),
      startMs: typeof row.startMs === "number" ? row.startMs : null,
      endMs: typeof row.endMs === "number" ? row.endMs : null,
    }];
  });
}

function normalizeDiarizationStatus(value: unknown): DiarizationStatus {
  switch (value) {
    case "matched_reference":
    case "diarized_without_reference":
    case "fallback_plain_text":
    case "disabled":
    case "not_enrolled":
      return value;
    default:
      return "diarized_without_reference";
  }
}

async function uploadVoiceFile(
  file: File,
  url: string,
  headers: Record<string, string>,
  contentType: string,
) {
  return file.upload(url, {
    httpMethod: "POST",
    uploadType: UploadType.BINARY_CONTENT,
    headers: {
      ...headers,
    },
    mimeType: contentType || "audio/wav",
    sessionType: "foreground",
  });
}

async function withTranscribeRetry<T>(attempt: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let index = 0; index <= RETRY_DELAYS_MS.length; index += 1) {
    try {
      return await attempt();
    } catch (err) {
      lastErr = err;
      if (index === RETRY_DELAYS_MS.length || !isRetryableTranscribeError(err)) {
        throw err;
      }
      await delay(RETRY_DELAYS_MS[index]);
    }
  }
  throw lastErr;
}

function isRetryableTranscribeError(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  if (!(err instanceof Error)) return false;
  const match = err.message.match(/failed:\s*(\d{3})/);
  if (!match) return false;
  const status = Number(match[1]);
  return status === 429 || (status >= 500 && status < 600);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeCaptureTempFile(capture: {
  wavId: string;
  base64: string;
}): File {
  const file = new File(Paths.cache, `ambient-${capture.wavId}.wav`);
  file.create({ overwrite: true });
  file.write(capture.base64, { encoding: EncodingType.Base64 });
  return file;
}

function filenameForContentType(contentType: string): string {
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase();
  if (mediaType === "audio/mp4") return "ambient-capture.mp4";
  if (mediaType === "audio/mpeg") return "ambient-capture.mp3";
  return "ambient-capture.wav";
}

function captureDedupeId(event: CaptureReadyEvent): string {
  return event.burstId ?? event.wavId;
}

function transcriptOccurredAt(event: TranscriptEvent): string {
  const time = event.endedAt ?? parseCapturedAt(event.capturedAt);
  return new Date(time || Date.now()).toISOString();
}

function captureOccurredAtMs(event: CaptureReadyEvent): number {
  return event.endedAt ?? parseCapturedAt(event.capturedAt) ?? Date.now();
}

function parseCapturedAt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}
