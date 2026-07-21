/**
 * PIN 硬件源（MR20 BLE 录音器 → 腾讯 RTASR 实时转写）。web
 * services/ambient/sources/pin-hardware.ts 的 RN 介质版，语义一致：
 * 状态快照 + final 转写入信号流；ASR 断流自愈（重新 mint 签名 URL →
 * restartAsr）放在源里而不是管理页——页面关着也能自愈。
 */
import type { EventSubscription } from "expo-modules-core";
import { mintPinHardwareAsrToken } from "@pin-ai/core";
import {
  PinHardware,
  type PinHardwareState,
  type PinHardwareTranscriptEvent,
} from "../../../modules/pin-hardware";
import {
  applyPinHardwareTranscriptEvent,
  pinHardwareSpeakerLabel,
} from "../live/pin-hardware-transcript-store";
import { SIGNAL_KINDS, type AmbientSource, type SourceContext } from "../types";

// Keep retrying while the user still wants hardware capture. The final delay
// is reused indefinitely so a long network/provider outage heals by itself.
const ASR_HEAL_DELAYS_MS = [1_000, 3_000, 8_000, 15_000, 30_000];
const CAPTURE_RESUME_DELAYS_MS = [0, 1_000, 3_000, 8_000, 15_000, 30_000];
const STATE_POLL_INTERVAL_MS = 30_000;

export function createPinHardwareSource(ctx: SourceContext): AmbientSource {
  let stateSub: EventSubscription | null = null;
  let transcriptSub: EventSubscription | null = null;
  let started = false;
  let lifecycleGeneration = 0;
  let lastStateKey: string | null = null;
  let asrHealingGeneration: number | null = null;
  let asrHealAttempts = 0;
  let captureResumeGeneration: number | null = null;
  let captureResumeAttempts = 0;
  let latestState: PinHardwareState | null = null;
  let statePollTimer: ReturnType<typeof setTimeout> | null = null;
  let speakerContextId: string | undefined;
  const ingestedFinalSentenceKeys = new Set<string>();

  function handleState(event: PinHardwareState): void {
    latestState = event;
    speakerContextId = event.speakerContextId?.trim() || undefined;
    if (event.captureRunning) captureResumeAttempts = 0;
    // Before the dedupe check: repeated asr_error emissions carry the same
    // state key, but each one may need another heal attempt.
    maybeHealAsr(event);
    maybeResumeCapture(event);
    const stateKey = JSON.stringify({
      supported: event.supported,
      connected: event.connected,
      scanning: event.scanning,
      captureRunning: event.captureRunning,
      captureDesired: event.captureDesired,
      bluetoothState: event.bluetoothState,
      deviceId: event.deviceId,
      deviceName: event.deviceName,
      batteryPercent: event.batteryPercent,
      status: event.status,
      asrState: event.asrState,
      speakerContextId: event.speakerContextId,
    });
    if (stateKey === lastStateKey) return;
    lastStateKey = stateKey;

    const observedAt = new Date(event.timestamp).toISOString();
    const summary = pinHardwareStateSummary(event);
    ctx.push({
      kind: SIGNAL_KINDS.pinHardwareState,
      title: event.connected ? "PIN hardware connected" : "PIN hardware state",
      summary,
      occurred_at: observedAt,
      payload: {
        schema_version: "pin_hardware_state.v1",
        supported: event.supported,
        connected: event.connected,
        scanning: event.scanning,
        capture_running: event.captureRunning,
        capture_desired: event.captureDesired,
        bluetooth_state: event.bluetoothState,
        device_id: event.deviceId,
        device_name: event.deviceName,
        battery_percent: event.batteryPercent,
        firmware_version: event.firmwareVersion,
        status: event.status,
        asr_state: event.asrState,
        audio_bytes_received: event.audioBytesReceived,
        last_audio_at: event.lastAudioAt,
        last_transcript_at: event.lastTranscriptAt,
        speaker_context_id: event.speakerContextId,
        devices: event.devices ?? [],
        observed_at: observedAt,
      },
      dedupe_key: `pin_hardware_state:${stateKey}:${observedAt}`,
    });
    ctx.onEvent("pin_hardware", summary);
  }

  /**
   * ASR self-heal: each new socket needs a freshly signed URL. The native
   * side surfaces provider/network failures as `asr_error`; we mint a new
   * URL and hand it back via restartAsr. A restart call only starts the
   * asynchronous handshake, so the retry budget resets only after real
   * transcript data proves the replacement stream is healthy.
  */
  function maybeHealAsr(event: PinHardwareState): void {
    // A provider can reject the socket before the restarted device stream is
    // marked active, so connection state — not captureRunning — is the safe
    // indication that this requested hardware session can still be healed.
    if (event.status !== "asr_error" || event.connected !== true || event.captureDesired === false) return;
    if (!started || asrHealingGeneration !== null) return;
    const generation = lifecycleGeneration;
    asrHealingGeneration = generation;
    const delay = retryDelay(ASR_HEAL_DELAYS_MS, asrHealAttempts);
    asrHealAttempts += 1;
    void (async () => {
      let retry = false;
      try {
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (!started || generation !== lifecycleGeneration) return;
        const token = await mintPinHardwareAsrToken({ speakerContextId });
        if (!started || generation !== lifecycleGeneration) return;
        await PinHardware.restartAsr({ asrUrl: token.url });
        ctx.onEvent("pin_hardware", `PIN hardware ASR stream restarted (attempt ${asrHealAttempts})`);
      } catch {
        // Mint or restart failed without a new native event to re-trigger
        // us — self-schedule another attempt with capped backoff.
        retry = started && generation === lifecycleGeneration;
        if (retry) ctx.onEvent("pin_hardware", "PIN hardware ASR recovery failed; retrying");
      } finally {
        if (asrHealingGeneration === generation) asrHealingGeneration = null;
      }
      if (retry && latestState) maybeHealAsr(latestState);
    })();
  }

  function maybeResumeCapture(event: PinHardwareState): void {
    if (!shouldResumeCapture(event) || !started || captureResumeGeneration !== null) return;
    const generation = lifecycleGeneration;
    captureResumeGeneration = generation;
    const delay = retryDelay(CAPTURE_RESUME_DELAYS_MS, captureResumeAttempts);
    captureResumeAttempts += 1;
    void (async () => {
      let retry = false;
      try {
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (!started || generation !== lifecycleGeneration) return;
        const current = await PinHardware.getState();
        latestState = current;
        if (!shouldResumeCapture(current)) return;
        const token = await mintPinHardwareAsrToken({ speakerContextId });
        if (!started || generation !== lifecycleGeneration) return;
        await PinHardware.startCapture({ asrUrl: token.url });
        ctx.onEvent("pin_hardware", `PIN hardware capture resumed (attempt ${captureResumeAttempts})`);
      } catch {
        retry = started && generation === lifecycleGeneration;
        if (retry) ctx.onEvent("pin_hardware", "PIN hardware capture resume failed; retrying");
      } finally {
        if (captureResumeGeneration === generation) captureResumeGeneration = null;
      }
      if (retry && latestState) maybeResumeCapture(latestState);
    })();
  }

  function scheduleStatePoll(generation: number): void {
    if (statePollTimer) clearTimeout(statePollTimer);
    statePollTimer = setTimeout(() => {
      statePollTimer = null;
      if (!started || generation !== lifecycleGeneration) return;
      void PinHardware.getState()
        .then((state) => {
          if (!started || generation !== lifecycleGeneration) return;
          handleState(state);
        })
        .catch(() => {})
        .finally(() => {
          if (started && generation === lifecycleGeneration) scheduleStatePoll(generation);
        });
    }, STATE_POLL_INTERVAL_MS);
  }

  function handleTranscript(event: PinHardwareTranscriptEvent): void {
    // Text is flowing again — the stream is healthy, so future drops get a
    // full retry budget.
    asrHealAttempts = 0;
    captureResumeAttempts = 0;
    if (event.speakerContextId?.trim()) speakerContextId = event.speakerContextId.trim();
    // The ambient source owns the page-independent live transcript stream.
    // Apply interim events before the durable-signal final-only guard so the
    // UI survives page unmounts and still updates partial sentences in place.
    applyPinHardwareTranscriptEvent(event);
    const finalizedSegments = (event.segments ?? []).filter(
      (segment) => segment.isFinal && segment.text.trim().length > 0,
    );
    const newFinalizedSegments = finalizedSegments.filter((segment, index) => {
      const key = `${event.voiceId ?? "s0"}:${segment.sentenceId ?? `${event.sliceIndex ?? "slice"}:${index}`}`;
      if (ingestedFinalSentenceKeys.has(key)) return false;
      ingestedFinalSentenceKeys.add(key);
      return true;
    });
    const text = newFinalizedSegments.length > 0
      ? newFinalizedSegments.map((segment) => segment.text.trim()).join("\n")
      : event.text.trim();
    if (finalizedSegments.length > 0 && newFinalizedSegments.length === 0) return;
    if (finalizedSegments.length === 0 && (!event.isFinal || !text)) return;
    const finalizedSentenceIds = newFinalizedSegments
      .map((segment) => segment.sentenceId)
      .join(",");

    ctx.push({
      kind: SIGNAL_KINDS.pinHardwareTranscript,
      title: "PIN hardware transcript",
      summary: text,
      occurred_at: event.capturedAt,
      payload: {
        schema_version: "pin_hardware_transcript.v1",
        provider: event.provider,
        device_id: event.deviceId,
        device_name: event.deviceName,
        is_final: event.isFinal,
        segments: newFinalizedSegments.length > 0 ? newFinalizedSegments : (event.segments ?? []),
        speaker_segments: speakerSegments(
          newFinalizedSegments.length > 0 ? newFinalizedSegments : (event.segments ?? []),
        ),
      },
      dedupe_key: `pin_hardware_transcript:${event.deviceId ?? "unknown"}:${event.voiceId ?? event.capturedAt}:${finalizedSentenceIds || text}`,
    });
    ctx.onEvent("pin_hardware", `PIN hardware transcript: ${text}`);
  }

  return {
    key: "pin_hardware",
    label: "PIN Hardware",
    isStarted: () => started,
    async start() {
      if (started) return;
      await PinHardware.requestPermissions();
      const generation = ++lifecycleGeneration;
      stateSub = PinHardware.addListener("pinHardwareState", handleState);
      transcriptSub = PinHardware.addListener("pinHardwareTranscript", handleTranscript);
      try {
        await PinHardware.startMonitoring();
        if (generation !== lifecycleGeneration) return;
        started = true;
        scheduleStatePoll(generation);
        handleState(await PinHardware.getState());
      } catch (err) {
        if (generation === lifecycleGeneration) lifecycleGeneration += 1;
        started = false;
        asrHealingGeneration = null;
        captureResumeGeneration = null;
        latestState = null;
        if (statePollTimer) clearTimeout(statePollTimer);
        statePollTimer = null;
        stateSub?.remove();
        transcriptSub?.remove();
        stateSub = null;
        transcriptSub = null;
        await PinHardware.stopMonitoring().catch(() => {});
        throw err;
      }
    },
    async refresh() {
      if (!started) return;
      const generation = lifecycleGeneration;
      const state = await PinHardware.getState();
      if (!started || generation !== lifecycleGeneration) return;
      handleState(state);
    },
    async stop() {
      lifecycleGeneration += 1;
      started = false;
      asrHealingGeneration = null;
      captureResumeGeneration = null;
      latestState = null;
      if (statePollTimer) clearTimeout(statePollTimer);
      statePollTimer = null;
      stateSub?.remove();
      transcriptSub?.remove();
      stateSub = null;
      transcriptSub = null;
      try {
        // Always clear native capture intent. iOS may have restored it before
        // the JS source starts; sign-out/global stop must still win.
        await PinHardware.stopCapture();
        await PinHardware.stopMonitoring();
      } finally {
        lastStateKey = null;
        asrHealAttempts = 0;
        speakerContextId = undefined;
        ingestedFinalSentenceKeys.clear();
      }
    },
  };
}

function retryDelay(delays: readonly number[], attempt: number): number {
  return delays[Math.min(attempt, delays.length - 1)] ?? 0;
}

function shouldResumeCapture(event: PinHardwareState): boolean {
  return event.connected === true
    && event.captureDesired === true
    && event.captureRunning !== true
    && event.status !== "asr_error"
    && event.asrState !== "connecting"
    && event.asrState !== "ready";
}

function pinHardwareStateSummary(event: PinHardwareState): string {
  if (!event.supported) return "PIN hardware is unavailable on this platform.";
  if (event.connected) {
    const name = event.deviceName?.trim() || "device";
    return `PIN hardware connected: ${name}.`;
  }
  if (event.scanning) return "PIN hardware scanning for nearby devices.";
  if (event.bluetoothState && event.bluetoothState !== "poweredOn") {
    return `PIN hardware waiting for Bluetooth: ${event.bluetoothState}.`;
  }
  return "PIN hardware ready to connect.";
}

function speakerSegments(
  segments: NonNullable<PinHardwareTranscriptEvent["segments"]>,
): Array<{ speaker: string; text: string }> {
  return segments.flatMap((segment) => {
    const text = segment.text.trim();
    if (!text) return [];
    const speaker = pinHardwareSpeakerLabel(segment.speakerId, segment.speakerLabel);
    return [{ speaker, text }];
  });
}
