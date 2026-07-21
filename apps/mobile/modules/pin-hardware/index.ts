/**
 * pin-hardware（Expo local module）JS 绑定：PINAI 硬件(MR20 录音器)BLE
 * 扫描/连接/自动重连 + BLE 音频 → 腾讯 RTASR 实时转写。Swift 核心原样迁移
 * 自 capacitor-plugins/ambient-ai 的 PinHardwarePlugin，方法面 1:1。
 */
import { requireOptionalNativeModule, type EventSubscription } from "expo-modules-core";

export interface PinHardwarePermissions {
  bluetooth: string;
}

export interface PinHardwareDevice {
  id: string;
  name: string;
  rssi?: number;
  connected?: boolean;
}

export interface PinHardwareState {
  supported: boolean;
  connected: boolean;
  scanning: boolean;
  captureRunning: boolean;
  /** Persisted user intent used to resume capture after process restoration. */
  captureDesired?: boolean;
  bluetoothState?: string;
  deviceId?: string;
  deviceName?: string;
  batteryPercent?: number;
  firmwareVersion?: string;
  status: string;
  /** Tencent WebSocket lifecycle, independent from the BLE capture state. */
  asrState?: "idle" | "connecting" | "ready" | "error";
  /** Total MP3 bytes received from the recorder in the current capture. */
  audioBytesReceived?: number;
  /** Epoch milliseconds for the latest BLE audio packet. */
  lastAudioAt?: number;
  /** Epoch milliseconds for the latest non-empty transcript result. */
  lastTranscriptAt?: number;
  /** Tencent's 24-hour context for keeping anonymous speaker ids stable. */
  speakerContextId?: string;
  devices?: PinHardwareDevice[];
  timestamp: number;
  /**
   * Whether the module should remember the paired recorder and reconnect
   * to it automatically (default-device toggle). Defaults to true.
   */
  autoReconnect?: boolean;
  /** Remembered default device, if one has been paired successfully. */
  preferredDeviceId?: string;
  preferredDeviceName?: string;
}

export interface PinHardwareTranscriptSegment {
  sentenceId?: number;
  speakerId?: string;
  speakerLabel?: string;
  text: string;
  isFinal: boolean;
  startMs?: number;
  endMs?: number;
}

export interface PinHardwareTranscriptEvent {
  text: string;
  isFinal: boolean;
  capturedAt: string;
  provider?: string;
  deviceId?: string;
  deviceName?: string;
  segments?: PinHardwareTranscriptSegment[];
  /**
   * Provider-side slice index (Tencent RTASR `result.index`) — stable
   * across interim → final for the same utterance, so consumers can
   * update-in-place instead of appending duplicate lines.
   */
  sliceIndex?: number;
  /** Tencent per-ASR-session id — sliceIndex restarts per session, so
   *  consumers must namespace line ids by voiceId to survive restartAsr. */
  voiceId?: string;
  speakerContextId?: string;
  startMs?: number;
  endMs?: number;
}

export interface PinHardwareStartCaptureOptions {
  /**
   * Signed WSS URL minted server-side by `/api/voice/hardware/tencent-token`.
   * Required before capture starts. The caller should fall back to the phone
   * microphone when the mint endpoint is unavailable.
   */
  asrUrl: string;
}

type PinHardwareEventName = "pinHardwareState" | "pinHardwareTranscript";

interface PinHardwareModuleType {
  requestPermissions(): Promise<PinHardwarePermissions>;
  checkPermissions(): Promise<PinHardwarePermissions>;
  getState(): Promise<PinHardwareState>;
  startMonitoring(): Promise<void>;
  stopMonitoring(): Promise<void>;
  startScan(): Promise<void>;
  stopScan(): Promise<void>;
  connect(options: { deviceId: string }): Promise<void>;
  disconnect(): Promise<void>;
  startCapture(options: PinHardwareStartCaptureOptions): Promise<void>;
  stopCapture(): Promise<void>;
  /** Clear provider speaker continuity when the signed-in account changes. */
  resetSpeakerContext(): Promise<void>;
  /**
   * Toggle the default-device behavior. Enabling adopts the currently
   * connected device as the remembered default; disabling forgets it and
   * stops all automatic reconnection.
   */
  setAutoReconnect(options: { enabled: boolean }): Promise<void>;
  /**
   * Re-open the ASR stream with a freshly minted signed URL after a drop
   * (status `asr_error`). The native side preserves the BLE connection but
   * restarts device recording after provider readiness so the new socket
   * receives a clean MP3 stream. Rejects when no capture session is active.
   */
  restartAsr(options: { asrUrl: string }): Promise<void>;
  addListener(eventName: PinHardwareEventName, listener: (event: never) => void): EventSubscription;
}

// 同 ambient-audio：Swift 未链接的 build 里 import 安全，调用时才抛。
export const PinHardware =
  requireOptionalNativeModule<PinHardwareModuleType>("PinHardware") ??
  (new Proxy(
    {},
    {
      get(_t, prop) {
        throw new Error(
          `PinHardware native module unavailable (Swift core not linked in this build): ${String(prop)}`,
        );
      },
    },
  ) as PinHardwareModuleType);
