import type { ReactNode } from "react";

export interface VoiceEngineCallbacks {
  onPartial(text: string): void;
  onFinal(text: string): void;
  onError(err: unknown): void;
}

export interface VoiceEngineHandle {
  stop(): void | Promise<void>;
  cancel?(): void | Promise<void>;
}

// Swappable speech-to-text runtime. The default engine uses browser-native
// SpeechRecognition; the GPT transcription engine is kept available for
// callers that explicitly inject it.
export interface VoiceEngine {
  start(callbacks: VoiceEngineCallbacks): VoiceEngineHandle | Promise<VoiceEngineHandle>;
}

export interface StartCaptureOptions {
  // Text already present in the target input when capture starts. The overlay
  // stays empty until new speech arrives; callers can use this as an append base.
  prefill?: string;
  // Fires on every transcript update (partial or final). Bind to input state for live transcription.
  onUpdate?(text: string): void;
  // Fires once when the user clicks "Done". Use for the commit step.
  // Not called on Cancel or backdrop dismiss.
  onResult?(text: string): void;
  // Caller renders its own recording UI (e.g. the chat composer's inline
  // recording bar) and drives stop/cancel via `stopCapture`; the provider then
  // suppresses its own global bottom-sheet overlay for this capture.
  inline?: boolean;
}

export interface VoiceContextValue {
  startCapture(opts?: StartCaptureOptions): void;
  // Commit (true → fires onResult) or cancel (false) the active capture. Lets
  // an inline caller drive its own Done / Cancel buttons.
  stopCapture(commit: boolean): void;
  isCapturing: boolean;
}

export interface VoiceProviderProps {
  children: ReactNode;
  // Defaults to browser-native SpeechRecognition.
  engine?: VoiceEngine;
  // User-preferred generation language. Voice transcription maps this to
  // browser BCP-47 hints; missing/unknown means Chinese.
  transcriptionLanguage?: string | null;
}
