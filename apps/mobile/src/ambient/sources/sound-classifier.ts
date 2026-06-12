/**
 * Sound-classifier 源（Swift 保留件：SoundAnalysis + 采集管道经
 * ambient-audio Expo module）。第一版覆盖核心链路：分类事件（低置信过
 * 滤 + 同标签折叠）、speech burst、转写（实时事件 + 启动 drain 积压）。
 * web 版（622 行）的 capture recovery / 健康检查等高级逻辑随后续刀补齐。
 */
import {
  AmbientAudio,
  type SoundClassificationEvent,
  type SpeechBurstEvent,
  type TranscriptEvent,
} from "../../../modules/ambient-audio";
import { type AmbientSource, type SourceContext } from "../types";

const SOUND_KIND = "device.sound_classification";
const TRANSCRIPT_KIND = "device.audio_transcript";
const MIN_CONFIDENCE = 0.55;

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

  function handleClassification(event: SoundClassificationEvent): void {
    const top = event.classifications?.[0];
    if (!top || top.confidence < MIN_CONFIDENCE) return;
    if (top.label === lastLabel) return; // 同标签折叠（speech speech speech）
    lastLabel = top.label;
    const summary = `${top.label} (${Math.round(top.confidence * 100)}%)`;
    ctx.push({
      kind: SOUND_KIND,
      title: "Ambient sound",
      summary,
      occurred_at: new Date(event.timestamp || Date.now()).toISOString(),
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
    ctx.push({
      kind: TRANSCRIPT_KIND,
      title: "Ambient transcript",
      summary: text.length > 140 ? `${text.slice(0, 140)}…` : text,
      occurred_at: new Date(event.endedAt || Date.now()).toISOString(),
      dedupe_key: event.wavId ? `transcript:${event.wavId}` : undefined,
      payload: {
        schema_version: "audio_transcript.v1",
        text,
        started_at: event.startedAt,
        ended_at: event.endedAt,
        provider: event.provider,
        session_id: event.sessionId,
      },
    });
    ctx.onEvent("sound_classifier", `transcript ${text.slice(0, 40)}`);
  }

  function handleSpeechBurst(event: SpeechBurstEvent): void {
    ctx.onEvent("sound_classifier", `speech burst ${Math.round(event.durationMs / 1000)}s`);
  }

  return {
    key: "sound_classifier",
    label: "Ambient audio",
    isStarted: () => started,
    async start() {
      if (started) return;
      const perm = await AmbientAudio.requestPermissions();
      if (perm.microphone !== "granted") throw new Error("microphone permission denied");
      await AmbientAudio.configure({
        ...LIVE_AUDIO_CONFIG,
        recognitionLocale: opts?.recognitionLocale?.(),
      });
      subs = [
        AmbientAudio.addListener("soundClassification", handleClassification),
        AmbientAudio.addListener("transcript", handleTranscript),
        AmbientAudio.addListener("speechBurst", handleSpeechBurst),
        AmbientAudio.addListener("audioError", (e: { message: string; source: string }) =>
          console.warn(`[ambient:audio] error ${e.source}: ${e.message}`),
        ),
      ];
      await AmbientAudio.startCapture();
      started = true;
      // 上次后台攒下的转写积压。
      const { transcripts } = await AmbientAudio.drainPendingTranscripts();
      for (const t of transcripts) handleTranscript(t);
    },
    async stop() {
      for (const s of subs) s.remove();
      subs = [];
      await AmbientAudio.stopCapture().catch(() => {});
      started = false;
      lastLabel = null;
    },
  };
}
