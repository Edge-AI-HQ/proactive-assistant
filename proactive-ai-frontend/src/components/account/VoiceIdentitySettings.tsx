import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, RotateCcw, Square, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { createPcmRecorder, type PcmRecorder } from "@/components/voice/pcm-recorder";
import { acquireExternalMic, type ExternalMicLease } from "@/services/ambient/external-mic";
import {
  deleteVoiceIdentityReference,
  fetchVoiceIdentity,
  setVoiceIdentityEnabled,
  uploadVoiceIdentityReference,
  type VoiceIdentityProfile,
} from "@/services/voice-identity-api";
import { useUserSettings } from "@pin-ai/state";
import { i18n, Text } from "@pin-ai/ui-web";

const TARGET_DURATION_MS = 5_000;
const MIN_DURATION_MS = 2_000;
const MAX_DURATION_MS = 10_000;
// Downsample the reference to 16 kHz: plenty for speaker diarization, and small
// enough that 10s base64-encoded stays under the transcription API's per-part cap.
const REFERENCE_SAMPLE_RATE = 16_000;
const ENGLISH_REFERENCE_PROMPT = "This morning I checked my schedule, and this afternoon I will reply to a colleague.";
const CHINESE_REFERENCE_PROMPT = "今天早上我整理了日程，下午会给同事回一条消息。";

export default function VoiceIdentitySettings() {
  const { t } = useTranslation("account");
  const { settings } = useUserSettings();
  const [profile, setProfile] = useState<VoiceIdentityProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [reviewBlob, setReviewBlob] = useState<Blob | null>(null);
  const [reviewUrl, setReviewUrl] = useState<string | null>(null);
  const [reviewDurationMs, setReviewDurationMs] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<PcmRecorder | null>(null);
  const leaseRef = useRef<ExternalMicLease | null>(null);
  const startedAtRef = useRef(0);
  const intervalRef = useRef<number | null>(null);
  const autoStopRef = useRef<number | null>(null);

  useEffect(() => {
    let mounted = true;
    void fetchVoiceIdentity()
      .then((next) => {
        if (mounted) setProfile(next);
      })
      .catch((err) => {
        if (mounted) setError(errorMessage(err));
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!reviewBlob) {
      setReviewUrl(null);
      return;
    }
    if (typeof URL === "undefined" || !URL.createObjectURL) return;
    const url = URL.createObjectURL(reviewBlob);
    setReviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [reviewBlob]);

  const clearTimers = useCallback(() => {
    if (intervalRef.current !== null) window.clearInterval(intervalRef.current);
    if (autoStopRef.current !== null) window.clearTimeout(autoStopRef.current);
    intervalRef.current = null;
    autoStopRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      clearTimers();
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder) void recorder.stop().catch(() => {});
      void leaseRef.current?.release();
      leaseRef.current = null;
    };
  }, [clearTimers]);

  const stopRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    recorderRef.current = null;
    clearTimers();
    setRecording(false);
    const durationMs = Math.min(Date.now() - startedAtRef.current, MAX_DURATION_MS);
    setElapsedMs(durationMs);
    try {
      const audio = await recorder.stop();
      setReviewBlob(audio);
      setReviewDurationMs(durationMs);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      // recorder.stop() released the mic tracks — hand ambient back now,
      // independent of upload, so it isn't left suppressed.
      await leaseRef.current?.release();
      leaseRef.current = null;
    }
  }, [clearTimers]);

  const startRecording = useCallback(async () => {
    setError(null);
    setReviewBlob(null);
    setReviewDurationMs(0);
    try {
      // Yield the native ambient mic before grabbing the WebView mic so the two
      // recorders don't fight over the shared iOS audio session.
      leaseRef.current = await acquireExternalMic();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = await createPcmRecorder(stream, { sampleRate: REFERENCE_SAMPLE_RATE });
      recorderRef.current = recorder;
      startedAtRef.current = Date.now();
      setElapsedMs(0);
      setRecording(true);
      intervalRef.current = window.setInterval(() => {
        setElapsedMs(Math.min(Date.now() - startedAtRef.current, MAX_DURATION_MS));
      }, 200);
      autoStopRef.current = window.setTimeout(() => {
        void stopRecording();
      }, MAX_DURATION_MS);
    } catch (err) {
      await leaseRef.current?.release();
      leaseRef.current = null;
      setError(errorMessage(err));
    }
  }, [stopRecording]);

  const saveReview = useCallback(async () => {
    if (!reviewBlob || reviewDurationMs < MIN_DURATION_MS) {
      setError(i18n.t("account:voiceIdentity.tooShort"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await uploadVoiceIdentityReference(reviewBlob, reviewDurationMs);
      setProfile(next);
      setReviewBlob(null);
      setReviewDurationMs(0);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [reviewBlob, reviewDurationMs]);

  const toggleEnabled = useCallback(async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setProfile(await setVoiceIdentityEnabled(enabled));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const deleteReference = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteVoiceIdentityReference();
      setProfile(null);
      setReviewBlob(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const reviewTooShort = Boolean(reviewBlob) && reviewDurationMs < MIN_DURATION_MS;
  const enrolled = profile !== null;
  const status = loading
    ? t("voiceIdentity.statusLoading")
    : !enrolled
      ? t("voiceIdentity.statusNotEnrolled")
      : profile.enabled
        ? t("voiceIdentity.statusEnrolled")
        : t("voiceIdentity.statusDisabled");
  const referencePrompt = voiceReferencePrompt(settings?.generationLanguage);

  return (
    <section className="glass-card-strong p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">{t("voiceIdentity.title")}</h2>
          <Text variant="caption" className="block mt-1 leading-relaxed text-foreground/45">
            {t("voiceIdentity.description")}
          </Text>
        </div>
        <Text variant="micro" weight="semibold" className="shrink-0 whitespace-nowrap rounded-full bg-foreground/[0.06] px-2.5 py-1 leading-none text-foreground/55">
          {status}
        </Text>
      </div>

      <div className="border-l-2 border-foreground/15 pl-3">
        <Text variant="micro" weight="semibold" className="block text-foreground/35">{t("voiceIdentity.readAloud")}</Text>
        <Text variant="label" weight="medium" className="block mt-1 leading-relaxed text-foreground/75">
          {referencePrompt}
        </Text>
      </div>

      {profile && (
        <div className="grid grid-cols-2 gap-2 text-caption text-foreground/55">
          <div>
            <span className="block text-foreground/35">{t("voiceIdentity.duration")}</span>
            <span className="font-medium text-foreground/75">{formatDuration(profile.referenceDurationMs ?? 0)}</span>
          </div>
          <div>
            <span className="block text-foreground/35">{t("voiceIdentity.updated")}</span>
            <span className="font-medium text-foreground/75">{formatDate(profile.updatedAt)}</span>
          </div>
        </div>
      )}

      {recording && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-foreground/10 bg-foreground/[0.03] px-3 py-3">
          <div className="min-w-0">
            <Text variant="bodySm" weight="semibold" className="block text-foreground">{t("voiceIdentity.recording", { duration: formatDuration(elapsedMs) })}</Text>
            <Text variant="caption" className="block text-foreground/45">{t("voiceIdentity.recordingTarget", { target: formatDuration(TARGET_DURATION_MS), max: formatDuration(MAX_DURATION_MS) })}</Text>
          </div>
          <button
            type="button"
            onClick={() => void stopRecording()}
            className="inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-foreground px-3 text-caption font-semibold text-background"
          >
            <Square size={13} />
            {t("voiceIdentity.stop")}
          </button>
        </div>
      )}

      {reviewBlob && !recording && (
        <div className="space-y-2 rounded-lg border border-foreground/10 bg-foreground/[0.03] px-3 py-3">
          <div className="flex items-center justify-between gap-3">
            <Text variant="bodySm" weight="semibold" className="block text-foreground">{t("voiceIdentity.review", { duration: formatDuration(reviewDurationMs) })}</Text>
            <button
              type="button"
              onClick={() => void startRecording()}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-foreground/[0.08] px-3 text-caption font-semibold text-foreground/70"
            >
              <RotateCcw size={13} />
              {t("voiceIdentity.reRecord")}
            </button>
          </div>
          {reviewUrl && <audio controls src={reviewUrl} className="w-full" />}
          {reviewTooShort && (
            <Text variant="caption" weight="medium" className="block text-red-500">{t("voiceIdentity.tooShort")}</Text>
          )}
          <button
            type="button"
            onClick={() => void saveReview()}
            disabled={busy || reviewTooShort}
            className="min-h-10 w-full rounded-lg bg-foreground px-3 text-label font-semibold text-background disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t("voiceIdentity.saveReference")}
          </button>
        </div>
      )}

      {!recording && !reviewBlob && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void startRecording()}
            disabled={busy || loading}
            className="inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-foreground px-3 text-label font-semibold text-background disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Mic size={14} />
            {profile ? t("voiceIdentity.reRecord") : t("voiceIdentity.recordSelfReference")}
          </button>
          {profile && !profile.enabled && (
            <button
              type="button"
              onClick={() => void toggleEnabled(true)}
              disabled={busy}
              className="min-h-10 rounded-lg bg-foreground/[0.08] px-3 text-label font-semibold text-foreground/70 disabled:opacity-40"
            >
              {t("voiceIdentity.enable")}
            </button>
          )}
          {profile && profile.enabled && (
            <button
              type="button"
              onClick={() => void toggleEnabled(false)}
              disabled={busy}
              className="min-h-10 rounded-lg bg-foreground/[0.08] px-3 text-label font-semibold text-foreground/70 disabled:opacity-40"
            >
              {t("voiceIdentity.disable")}
            </button>
          )}
          {profile && (
            <button
              type="button"
              onClick={() => void deleteReference()}
              disabled={busy}
              className="inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-red-500/10 px-3 text-label font-semibold text-red-600 disabled:opacity-40"
            >
              <Trash2 size={14} />
              {t("voiceIdentity.delete")}
            </button>
          )}
        </div>
      )}

      {error && <Text variant="caption" weight="medium" className="block leading-snug text-red-500">{error}</Text>}
    </section>
  );
}

function formatDuration(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))}s`;
}

function formatDate(value: string | null): string {
  if (!value) return i18n.t("account:voiceIdentity.never");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return i18n.t("account:voiceIdentity.unknown");
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function voiceReferencePrompt(language: string | null | undefined): string {
  return language?.toLowerCase().startsWith("zh")
    ? CHINESE_REFERENCE_PROMPT
    : ENGLISH_REFERENCE_PROMPT;
}
