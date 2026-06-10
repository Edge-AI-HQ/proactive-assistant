import type { VoiceEngine, VoiceEngineCallbacks, VoiceEngineHandle } from "./types";

interface BrowserSpeechOptions {
  lang?: string;
  continuous?: boolean;
}

// Browser-native STT via webkitSpeechRecognition / SpeechRecognition.
// Works locally and on Safari iOS, but quality is uneven. Keep it available
// for explicit fallback injection; it is not enabled by default.
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

    const segments: string[] = [];

    recognition.onresult = (event) => {
      const startIndex = typeof event.resultIndex === "number" ? event.resultIndex : 0;
      let hasFinal = false;
      for (let i = startIndex; i < event.results.length; i++) {
        segments[i] = event.results[i][0].transcript;
        if (event.results[i].isFinal) hasFinal = true;
      }
      const transcript = segments.slice(0, event.results.length).join("");
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
        return waitForRecognitionEnd(recognition, () => recognition.stop());
      },
      cancel() {
        return waitForRecognitionEnd(recognition, () => {
          if (recognition.abort) recognition.abort();
          else recognition.stop();
        });
      },
    };
  }
}

function waitForRecognitionEnd(recognition: SpeechRecognitionLike, stop: () => void): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const previousOnEnd = recognition.onend;
    const timeout = window.setTimeout(finish, 800);

    function finish() {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      recognition.onend = previousOnEnd;
      resolve();
    }

    recognition.onend = (event) => {
      previousOnEnd?.(event);
      finish();
    };

    try {
      stop();
    } catch {
      finish();
    }
  });
}

// Minimal local typing for webkit SpeechRecognition — the DOM lib doesn't
// ship this and we don't want to pollute global declarations.
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: {
    resultIndex?: number;
    results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }>;
  }) => void) | null;
  onerror: ((event: { error?: unknown }) => void) | null;
  onend: ((event?: unknown) => void) | null;
  start(): void;
  stop(): void;
  abort?(): void;
}
