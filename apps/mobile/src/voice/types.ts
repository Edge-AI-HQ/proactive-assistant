export type VoiceCaptureStatus = "idle" | "connecting" | "listening";

export interface StartCaptureOptions {
  prefill?: string;
  onUpdate?: (text: string) => void;
  onError?: (message: string) => void;
  onResult?: (text: string) => void;
}

export interface VoiceInputContextValue {
  startCapture: (options?: StartCaptureOptions) => void;
  stopCapture: (commit: boolean) => Promise<void>;
  isCapturing: boolean;
  captureStatus: VoiceCaptureStatus;
}
