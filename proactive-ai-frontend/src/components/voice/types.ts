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

// Swappable speech-to-text runtime. The default engine records locally and
// sends audio to the backend GPT transcription endpoint; BrowserSpeechEngine
// stays as the browser-native fallback.
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
  // Defaults to the backend GPT transcription engine with browser-native fallback.
  engine?: VoiceEngine;
  // User-preferred generation language. Voice transcription maps this to
  // OpenAI ISO-639-1 and browser BCP-47 hints; missing/unknown means Chinese.
  transcriptionLanguage?: string | null;
}
