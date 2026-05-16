import type { VoiceEngine, VoiceEngineCallbacks, VoiceEngineHandle } from "./types";

interface BrowserSpeechOptions {
  lang?: string;
  continuous?: boolean;
}

// Browser-native STT via webkitSpeechRecognition / SpeechRecognition.
// Works locally and on Safari iOS; quality is uneven. Kept as the default
// fallback until the backend streaming engine ships.
export class BrowserSpeechEngine implements VoiceEngine {
  private readonly lang: string;
  private readonly continuous: boolean;

  constructor(options: BrowserSpeechOptions = {}) {
    this.lang = options.lang ?? "zh-CN";
    this.continuous = options.continuous ?? true;
  }

  start(callbacks: VoiceEngineCallbacks): VoiceEngineHandle {
    const SpeechRecognitionAPI =
      (window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike }).SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike }).webkitSpeechRecognition;

    if (!SpeechRecognitionAPI) {
      callbacks.onError(new Error("SpeechRecognition API not supported"));
      return { stop: () => {} };
    }

    const recognition = new SpeechRecognitionAPI();
    recognition.continuous = this.continuous;
    recognition.interimResults = true;
    if (this.lang) recognition.lang = this.lang;

    recognition.onresult = (event) => {
      let transcript = "";
      let hasFinal = false;
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
        if (event.results[i].isFinal) hasFinal = true;
      }
      if (hasFinal) callbacks.onFinal(transcript);
      else callbacks.onPartial(transcript);
    };
    recognition.onerror = (e) => {
      callbacks.onError(e?.error ?? e);
    };

    try {
      recognition.start();
    } catch (err) {
      callbacks.onError(err);
    }

    return {
      stop() {
        try {
          recognition.stop();
        } catch {
          // already stopped
        }
      },
    };
  }
}

// Minimal local typing for webkit SpeechRecognition — the DOM lib doesn't
// ship this and we don't want to pollute global declarations.
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }> }) => void) | null;
  onerror: ((event: { error?: unknown }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
