/**
 * Sound-classifier 源（Swift 保留件：SoundAnalysis + 采集管道经
 * ambient-audio Expo module）。第一版覆盖核心链路：分类事件（低置信过
 * 滤 + 同标签折叠）、speech burst、转写（实时事件 + 启动 drain 积压）。
 * web 版（622 行）的 capture recovery / 健康检查等高级逻辑随后续刀补齐。
 */
import { SoundRunAggregator, getTransportConfig } from "@pin-ai/core";
import { EncodingType, File, Paths, UploadType } from "expo-file-system";
import {
  AmbientAudio,
  type CaptureReadyEvent,
  type SoundClassificationEvent,
  type SpeechBurstEvent,
  type TranscriptEvent,
} from "../../../modules/ambient-audio";
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

// 与 web LIVE_AUDIO_CONFIG 一致（分段节奏参数）。
const LIVE_AUDIO_CONFIG = {
  preRollMs: 2_000,
  postRollMs: 5_000,
  maxBurstMs: 20_000,
  minBurstMs: 1_000,
  sessionSilenceGapMs: 30_000,
  maxSessionDurationMs: 5 * 60_000,
} as const;

export function createSoundClassifierSource(
  ctx: SourceContext,
  opts?: { recognitionLocale?: () => string | undefined },
): AmbientSource {
  let subs: { remove(): void }[] = [];
  let started = false;
  let lastLabel: string | null = null;
  const handledCaptureIds = new Set<string>();
  const inFlightCaptureIds = new Set<string>();
  const runs = new SoundRunAggregator();

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

  function handleTranscript(event: TranscriptEvent): void {
    const text = event.text?.trim();
    if (!text) return;
    const occurredAt = transcriptOccurredAt(event);
    const captureSessionId = event.captureSessionId ?? event.sessionId;
    const dedupeId = event.burstId ?? event.wavId;
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
    ctx.onEvent("sound_classifier", `transcript ${text.slice(0, 40)}`);
  }

  async function handleCaptureReady(event: CaptureReadyEvent): Promise<void> {
    const id = captureDedupeId(event);
    if (handledCaptureIds.has(id) || inFlightCaptureIds.has(id)) return;
    ctx.onEvent("sound_classifier", `capture ready ${Math.round(event.durationMs / 1000)}s`);
    inFlightCaptureIds.add(id);
    try {
      const text = await transcribeCapture(event);
      handledCaptureIds.add(id);
      if (text) {
        handleTranscript(captureTranscriptEvent(event, text));
      }
      await AmbientAudio.markCaptureProcessed(event.wavId);
    } catch (err) {
      console.warn("[ambient:audio] voice transcription failed:", err);
      ctx.onEvent("sound_classifier", `transcription failed ${id}`);
    } finally {
      inFlightCaptureIds.delete(id);
    }
  }

  async function transcribeCapture(event: CaptureReadyEvent): Promise<string> {
    const capture = await AmbientAudio.readCapture(event.wavId);
    const file = writeCaptureTempFile(capture);
    try {
      return await withTranscribeRetry(() =>
        transcribeVoiceFile(file, capture.contentType, {
          language: opts?.recognitionLocale?.(),
        }),
      );
    } finally {
      try {
        file.delete();
      } catch {
        // Best-effort cache cleanup only.
      }
    }
  }

  async function recoverPendingCaptures(): Promise<void> {
    let cursor: string | null = null;
    for (let page = 0; page < RECENT_CAPTURE_RECOVERY_MAX_PAGES; page += 1) {
      if (!started) return;
      const { captures } = await AmbientAudio.listRecentCaptures(
        RECENT_CAPTURE_RECOVERY_BATCH_SIZE,
        cursor,
        "asc",
      );
      if (!started || captures.length === 0) return;
      for (const capture of captures) {
        if (!started) return;
        await handleCaptureReady(capture);
      }
      if (captures.length < RECENT_CAPTURE_RECOVERY_BATCH_SIZE) return;
      cursor = captures[captures.length - 1]?.capturedAt ?? null;
      if (!cursor) return;
    }
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
        recognitionLocale: opts?.recognitionLocale?.(),
      });
      subs = [
        AmbientAudio.addListener("soundClassification", handleClassification),
        AmbientAudio.addListener("captureReady", (event: CaptureReadyEvent) => {
          void handleCaptureReady(event);
        }),
        AmbientAudio.addListener("transcript", handleTranscript),
        AmbientAudio.addListener("speechBurst", handleSpeechBurst),
        AmbientAudio.addListener("audioError", (e: { message: string; source: string }) =>
          console.warn(`[ambient:audio] error ${e.source}: ${e.message}`),
        ),
      ];
      await AmbientAudio.startCapture();
      started = true;
      const state = await AmbientAudio.getState().catch(() => null);
      ctx.onEvent(
        "sound_classifier",
        state?.running ? "audio capture running" : "audio capture start requested",
      );
      // 上次后台攒下的转写积压。
      const { transcripts } = await AmbientAudio.drainPendingTranscripts();
      for (const t of transcripts) handleTranscript(t);
      void recoverPendingCaptures().catch((err) => {
        console.warn("[ambient:audio] pending capture recovery failed:", err);
      });
    },
    async stop() {
      for (const s of subs) s.remove();
      subs = [];
      await AmbientAudio.stopCapture().catch(() => {});
      const finalized = runs.stop();
      if (finalized) ctx.push(finalized);
      started = false;
      lastLabel = null;
      inFlightCaptureIds.clear();
    },
  };
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

async function withTranscribeRetry(attempt: () => Promise<string>): Promise<string> {
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

function captureTranscriptEvent(event: CaptureReadyEvent, text: string): TranscriptEvent {
  const endMs = captureOccurredAtMs(event);
  const durationMs = Number.isFinite(event.durationMs) ? event.durationMs : 0;
  return {
    platform: event.platform ?? "ios",
    text,
    wavId: event.wavId,
    burstId: event.burstId,
    captureSessionId: event.captureSessionId ?? event.sessionId,
    capturedAt: new Date(endMs).toISOString(),
    durationMs,
    startedAt: Math.max(0, endMs - durationMs),
    endedAt: endMs,
    provider: "cloud_whisper",
    sessionId: event.captureSessionId ?? event.sessionId,
    fallback: false,
    triggerSource: event.triggerSource,
  };
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
