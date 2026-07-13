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
import { SIGNAL_KINDS, type AmbientSource, type SourceContext } from "../types";

// ASR self-heal backoff per consecutive attempt; the counter resets when a
// transcript actually flows again.
const ASR_HEAL_DELAYS_MS = [1_000, 3_000, 8_000];

export function createPinHardwareSource(ctx: SourceContext): AmbientSource {
  let stateSub: EventSubscription | null = null;
  let transcriptSub: EventSubscription | null = null;
  let started = false;
  let lifecycleGeneration = 0;
  let lastStateKey: string | null = null;
  let asrHealingGeneration: number | null = null;
  let asrHealAttempts = 0;

  function handleState(event: PinHardwareState): void {
    // Before the dedupe check: repeated asr_error emissions carry the same
    // state key, but each one may need another heal attempt.
    maybeHealAsr(event);
    const stateKey = JSON.stringify({
      supported: event.supported,
      connected: event.connected,
      scanning: event.scanning,
      captureRunning: event.captureRunning,
      bluetoothState: event.bluetoothState,
      deviceId: event.deviceId,
      deviceName: event.deviceName,
      batteryPercent: event.batteryPercent,
      status: event.status,
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
        bluetooth_state: event.bluetoothState,
        device_id: event.deviceId,
        device_name: event.deviceName,
        battery_percent: event.batteryPercent,
        firmware_version: event.firmwareVersion,
        status: event.status,
        devices: event.devices ?? [],
        observed_at: observedAt,
      },
      dedupe_key: `pin_hardware_state:${stateKey}:${observedAt}`,
    });
    ctx.onEvent("pin_hardware", summary);
  }

  /**
   * ASR self-heal: the signed WSS URL lives ~60s and Tencent drops the
   * socket on errors, so a long capture session loses its transcript
   * stream while BLE keeps delivering audio. The native side surfaces
   * that as `asr_error` (capture still running); we mint a fresh URL and
   * hand it back via restartAsr. Capped retries with backoff so a dead
   * backend doesn't turn into a mint loop.
   */
  function maybeHealAsr(event: PinHardwareState): void {
    if (event.status !== "asr_error" || event.captureRunning !== true) return;
    if (!started || asrHealingGeneration !== null || asrHealAttempts >= ASR_HEAL_DELAYS_MS.length) return;
    const generation = lifecycleGeneration;
    asrHealingGeneration = generation;
    const delay = ASR_HEAL_DELAYS_MS[asrHealAttempts];
    asrHealAttempts += 1;
    void (async () => {
      let retry = false;
      try {
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (!started || generation !== lifecycleGeneration) return;
        const token = await mintPinHardwareAsrToken();
        if (!started || generation !== lifecycleGeneration) return;
        await PinHardware.restartAsr({ asrUrl: token.url });
        ctx.onEvent("pin_hardware", `PIN hardware ASR stream restarted (attempt ${asrHealAttempts})`);
        // 重启成功 = 本次断流事故已处理完:预算按事故计,不按整场会话计。
        // 只靠转录事件清零的话,安静环境里每 ~60s 一次的正常 TTL 断流会把
        // 3 次预算烧光,之后整场不再自愈。
        asrHealAttempts = 0;
      } catch {
        // Mint or restart failed without a new native event to re-trigger
        // us — self-schedule the next attempt while budget remains.
        retry = started
          && generation === lifecycleGeneration
          && asrHealAttempts < ASR_HEAL_DELAYS_MS.length;
      } finally {
        if (asrHealingGeneration === generation) asrHealingGeneration = null;
      }
      if (retry) maybeHealAsr(event);
    })();
  }

  function handleTranscript(event: PinHardwareTranscriptEvent): void {
    // Text is flowing again — the stream is healthy, so future drops get a
    // full retry budget.
    asrHealAttempts = 0;
    const text = event.text.trim();
    if (!event.isFinal || !text) return;

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
        segments: event.segments ?? [],
        speaker_segments: speakerSegments(event),
      },
      dedupe_key: `pin_hardware_transcript:${event.deviceId ?? "unknown"}:${event.capturedAt}:${text}`,
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
        handleState(await PinHardware.getState());
      } catch (err) {
        if (generation === lifecycleGeneration) lifecycleGeneration += 1;
        started = false;
        asrHealingGeneration = null;
        stateSub?.remove();
        transcriptSub?.remove();
        stateSub = null;
        transcriptSub = null;
        await PinHardware.stopMonitoring().catch(() => {});
        throw err;
      }
    },
    async stop() {
      if (!started && stateSub === null && transcriptSub === null) return;
      lifecycleGeneration += 1;
      started = false;
      asrHealingGeneration = null;
      stateSub?.remove();
      transcriptSub?.remove();
      stateSub = null;
      transcriptSub = null;
      try {
        await PinHardware.stopCapture();
        await PinHardware.stopMonitoring();
      } finally {
        lastStateKey = null;
        asrHealAttempts = 0;
      }
    },
  };
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

function speakerSegments(event: PinHardwareTranscriptEvent): Array<{ speaker: string; text: string }> {
  return (event.segments ?? []).flatMap((segment) => {
    const text = segment.text.trim();
    if (!text) return [];
    const speaker = segment.speakerLabel?.trim()
      || (segment.speakerId?.trim() ? `Speaker ${segment.speakerId.trim()}` : "PIN hardware");
    return [{ speaker, text }];
  });
}
