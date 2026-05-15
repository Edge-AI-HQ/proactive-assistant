import type { ReactNode } from "react";

export interface VoiceEngineCallbacks {
  onPartial(text: string): void;
  onFinal(text: string): void;
  onError(err: unknown): void;
}

export interface VoiceEngineHandle {
  stop(): void;
}

// Swappable speech-to-text runtime. Phase A ships BrowserSpeechEngine
// (webkitSpeechRecognition). Phase B: a backend-streaming engine
// (GPT / Whisper realtime / etc.) plugs in via this same interface —
// pass it as <VoiceProvider engine={new BackendEngine(...)} />.
export interface VoiceEngine {
  start(callbacks: VoiceEngineCallbacks): VoiceEngineHandle | Promise<VoiceEngineHandle>;
}

export interface StartCaptureOptions {
  // Initial display text in the overlay before any speech arrives.
  // Useful for "AI wants to know: …" prompts.
  prefill?: string;
  // Fires on every transcript update (partial or final). Bind to input state for live transcription.
  onUpdate?(text: string): void;
  // Fires once when the user clicks "Done". Use for the commit step.
  // Not called on Cancel or backdrop dismiss.
  onResult?(text: string): void;
}

export interface VoiceContextValue {
  startCapture(opts?: StartCaptureOptions): void;
  isCapturing: boolean;
}

export interface VoiceProviderProps {
  children: ReactNode;
  // Defaults to BrowserSpeechEngine(). Swap for the backend-streaming engine when ready.
  engine?: VoiceEngine;
}
