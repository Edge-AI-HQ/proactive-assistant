import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Mic2 } from "lucide-react";
import {
  AmbientAi,
  type AmbientEventMap,
  type AudioCaptureConfig,
  type AudioState,
  type RecentAudioCapture,
  type TranscriptReadyEvent,
} from "@pin/capacitor-ambient-ai";

type AudioDebugEventName =
  | "audioState"
  | "soundClassification"
  | "speechBurst"
  | "transcriptDraft"
  | "transcriptRefined"
  | "transcriptReady"
  | "audioError";

interface AudioDebugEvent {
  id: number;
  name: AudioDebugEventName;
  receivedAt: number;
  preview: string;
}

interface SpeechGateState {
  top: AmbientEventMap["soundClassification"]["classifications"];
  consecutiveSpeechCount: number;
  lastBurstConfidence: number | null;
  lastBurstAt: number | null;
}

type RecordingSessionStatus = "idle" | "capturing" | "transcribing" | "ready" | "empty" | "error";

interface RecordingSession {
  status: RecordingSessionStatus;
  burstId: string | null;
  wavId: string | null;
  durationMs: number | null;
  draftText: string | null;
  finalText: string | null;
  provider: string | null;
  fallback: boolean | null;
  confidence: number | null;
  transcriptLocale: string | null;
  updatedAt: number;
}

interface RecordingRun {
  id: string;
  burstId: string;
  wavId: string;
  durationMs: number;
  text: string;
  provider: string;
  fallback: boolean;
  confidence: number | null;
  transcriptLocale: string | null;
  capturedAt: string;
}

type AudioRecognitionLocale = "auto" | "zh-CN" | "en-US";

type AudioConfigNumberField =
  | "cloudRefineTimeoutMs"
  | "preRollMs"
  | "postRollMs"
  | "maxBurstMs"
  | "wavRetentionTtlMs"
  | "wavMaxFiles";

interface AudioConfigForm {
  cloudMode: NonNullable<AudioCaptureConfig["cloudMode"]>;
  recognitionLocale: AudioRecognitionLocale;
  cloudApiKey: string;
  modelName: string;
  cloudRefineTimeoutMs: string;
  preRollMs: string;
  postRollMs: string;
  maxBurstMs: string;
  wavRetentionTtlMs: string;
  wavMaxFiles: string;
}

type StoredAudioConfigForm = Omit<AudioConfigForm, "cloudApiKey">;

const AUDIO_EVENT_NAMES: readonly AudioDebugEventName[] = [
  "audioState",
  "soundClassification",
  "speechBurst",
  "transcriptDraft",
  "transcriptRefined",
  "transcriptReady",
  "audioError",
];

const SPEECH_CONFIDENCE_THRESHOLD = 0.60;
const SPEECH_CONSECUTIVE_FRAMES = 1;
const AUDIO_CONFIG_STORAGE_KEY = "pinai:ambient-audio-debug-config:v1";
const SOUND_CONFIDENCE_THRESHOLD_STORAGE_KEY = "pinai:ambient-audio-debug-sound-threshold:v1";
const DEFAULT_SOUND_CONFIDENCE_PERCENT = 50;

function readStoredSoundConfidencePercent(): number {
  if (typeof window === "undefined") return DEFAULT_SOUND_CONFIDENCE_PERCENT;
  try {
    const raw = window.localStorage.getItem(SOUND_CONFIDENCE_THRESHOLD_STORAGE_KEY);
    if (!raw) return DEFAULT_SOUND_CONFIDENCE_PERCENT;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return DEFAULT_SOUND_CONFIDENCE_PERCENT;
    return Math.min(100, Math.max(0, Math.round(parsed)));
  } catch {
    return DEFAULT_SOUND_CONFIDENCE_PERCENT;
  }
}

function saveStoredSoundConfidencePercent(value: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SOUND_CONFIDENCE_THRESHOLD_STORAGE_KEY, String(value));
  } catch {
    return;
  }
}

const INITIAL_CONFIG: AudioConfigForm = {
  cloudMode: "off",
  recognitionLocale: "auto",
  cloudApiKey: "",
  modelName: "",
  cloudRefineTimeoutMs: "15000",
  preRollMs: "500",
  postRollMs: "10000",
  maxBurstMs: "30000",
  wavRetentionTtlMs: "3600000",
  wavMaxFiles: "12",
};

const AUDIO_CONFIG_NUMBER_FIELDS: readonly AudioConfigNumberField[] = [
  "cloudRefineTimeoutMs",
  "preRollMs",
  "postRollMs",
  "maxBurstMs",
  "wavRetentionTtlMs",
  "wavMaxFiles",
];

function formatTime(value: string | number): string {
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDuration(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function formatBytes(byteSize: number): string {
  if (byteSize < 1024) return `${byteSize} B`;
  return `${(byteSize / 1000).toFixed(1)} KB`;
}

function parseOptionalNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

function isCloudMode(value: unknown): value is AudioConfigForm["cloudMode"] {
  return value === "off" || value === "devDirect" || value === "proxy";
}

function isRecognitionLocale(value: unknown): value is AudioRecognitionLocale {
  return value === "auto" || value === "zh-CN" || value === "en-US";
}

function storedText(value: unknown, fallback: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

function readStoredConfig(): AudioConfigForm | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(AUDIO_CONFIG_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Record<keyof StoredAudioConfigForm, unknown>>;
    const next: AudioConfigForm = {
      ...INITIAL_CONFIG,
      cloudApiKey: "",
      cloudMode: isCloudMode(parsed.cloudMode) ? parsed.cloudMode : INITIAL_CONFIG.cloudMode,
      recognitionLocale: isRecognitionLocale(parsed.recognitionLocale)
        ? parsed.recognitionLocale
        : INITIAL_CONFIG.recognitionLocale,
      modelName: storedText(parsed.modelName, INITIAL_CONFIG.modelName),
    };
    for (const key of AUDIO_CONFIG_NUMBER_FIELDS) {
      next[key] = storedText(parsed[key], INITIAL_CONFIG[key]);
    }
    return next;
  } catch {
    return null;
  }
}

function saveStoredConfig(form: AudioConfigForm): void {
  if (typeof window === "undefined") return;
  const stored: StoredAudioConfigForm = {
    cloudMode: form.cloudMode,
    recognitionLocale: form.recognitionLocale,
    modelName: form.modelName,
    cloudRefineTimeoutMs: form.cloudRefineTimeoutMs,
    preRollMs: form.preRollMs,
    postRollMs: form.postRollMs,
    maxBurstMs: form.maxBurstMs,
    wavRetentionTtlMs: form.wavRetentionTtlMs,
    wavMaxFiles: form.wavMaxFiles,
  };
  try {
    window.localStorage.setItem(AUDIO_CONFIG_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    return;
  }
}

function summarizeAudioState(state: AudioState): string {
  const parts = [
    `running: ${state.running}`,
    `paused: ${state.paused}`,
    `capturing: ${state.capturing}`,
    `suppressed: ${state.suppressed}${state.suppressedReason ? ` (${state.suppressedReason})` : ""}`,
  ];
  if (state.engineState) parts.push(`engine: ${state.engineState}`);
  if (typeof state.capturePipelineRunning === "boolean") {
    parts.push(`capture pipeline: ${state.capturePipelineRunning}`);
  }
  if (typeof state.lastClassificationAt === "number") {
    parts.push(`last classification: ${formatTime(state.lastClassificationAt)}`);
  }
  if (typeof state.classifierRestartCount === "number") {
    parts.push(`restart count: ${state.classifierRestartCount}`);
  }
  if (state.lastAudioError) parts.push(`last error: ${state.lastAudioError}`);
  return parts.join(" · ");
}

function previewEvent<K extends AudioDebugEventName>(name: K, event: AmbientEventMap[K]): string {
  switch (name) {
    case "audioState":
      return summarizeAudioState(event as AmbientEventMap["audioState"]);
    case "soundClassification": {
      const frame = event as AmbientEventMap["soundClassification"];
      return frame.classifications.map((entry) => `${entry.label} ${(entry.confidence * 100).toFixed(0)}%`).join(" · ");
    }
    case "speechBurst": {
      const burst = event as AmbientEventMap["speechBurst"];
      return `${formatDuration(burst.durationMs)} · confidence ${(burst.confidence * 100).toFixed(0)}%`;
    }
    case "transcriptDraft": {
      const draft = event as AmbientEventMap["transcriptDraft"];
      return `${draft.wavId}${draft.transcriptLocale ? ` · ${draft.transcriptLocale}` : ""} · ${draft.text}`;
    }
    case "transcriptRefined": {
      const refined = event as AmbientEventMap["transcriptRefined"];
      return `${refined.wavId}${refined.transcriptLocale ? ` · ${refined.transcriptLocale}` : ""} · ${refined.provider} · ${refined.refinedText}`;
    }
    case "transcriptReady": {
      const ready = event as AmbientEventMap["transcriptReady"];
      return `${ready.wavId}${ready.transcriptLocale ? ` · ${ready.transcriptLocale}` : ""} · ${ready.provider}${ready.fallback ? " fallback" : ""} · ${ready.text}`;
    }
    case "audioError": {
      const error = event as AmbientEventMap["audioError"];
      return `${error.source}: ${error.message}`;
    }
    default:
      return JSON.stringify(event);
  }
}

function buildConfig(form: AudioConfigForm): AudioCaptureConfig {
  const config: AudioCaptureConfig = { cloudMode: form.cloudMode };
  if (form.recognitionLocale !== "auto") config.recognitionLocale = form.recognitionLocale;
  if (form.cloudApiKey.trim()) config.cloudApiKey = form.cloudApiKey.trim();
  if (form.modelName.trim()) config.modelName = form.modelName.trim();

  const cloudRefineTimeoutMs = parseOptionalNumber(form.cloudRefineTimeoutMs);
  const preRollMs = parseOptionalNumber(form.preRollMs);
  const postRollMs = parseOptionalNumber(form.postRollMs);
  const maxBurstMs = parseOptionalNumber(form.maxBurstMs);
  const wavRetentionTtlMs = parseOptionalNumber(form.wavRetentionTtlMs);
  const wavMaxFiles = parseOptionalNumber(form.wavMaxFiles);

  if (cloudRefineTimeoutMs !== undefined) config.cloudRefineTimeoutMs = cloudRefineTimeoutMs;
  if (preRollMs !== undefined) config.preRollMs = preRollMs;
  if (postRollMs !== undefined) config.postRollMs = postRollMs;
  if (maxBurstMs !== undefined) config.maxBurstMs = maxBurstMs;
  if (wavRetentionTtlMs !== undefined) config.wavRetentionTtlMs = wavRetentionTtlMs;
  if (wavMaxFiles !== undefined) config.wavMaxFiles = wavMaxFiles;

  return config;
}

function CollapsibleSection({
  title,
  count,
  defaultOpen = true,
  children,
}: {
  title: string;
  count?: number;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center gap-1 text-[10px] font-medium text-foreground/40 uppercase tracking-wider hover:text-foreground/60 transition-colors"
      >
        {open ? <ChevronDown size={12} strokeWidth={1.75} /> : <ChevronRight size={12} strokeWidth={1.75} />}
        <span>{title}</span>
        {typeof count === "number" && (
          <span className="ml-1 rounded-md bg-foreground/10 px-1.5 py-0.5 text-[9px] tabular-nums text-foreground/55 normal-case tracking-normal">
            {count}
          </span>
        )}
      </button>
      {open && (
        <div className="mt-1.5 max-h-[280px] overflow-y-auto space-y-1.5 pr-1">
          {children}
        </div>
      )}
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block text-[10px] font-medium text-foreground/45">
      {label}
      <input
        type="number"
        min={0}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        className="mt-1 w-full rounded-md border border-foreground/10 bg-white/60 px-2 py-1 text-[12px] text-foreground/70 focus:outline-none focus:ring-2 focus:ring-primary/30"
      />
    </label>
  );
}

export default function AmbientAudioDebugPanel() {
  const [form, setForm] = useState<AudioConfigForm>(() => readStoredConfig() ?? INITIAL_CONFIG);
  const [state, setState] = useState<AudioState | null>(null);
  const [captures, setCaptures] = useState<RecentAudioCapture[]>([]);
  const [drained, setDrained] = useState<TranscriptReadyEvent[]>([]);
  const [events, setEvents] = useState<AudioDebugEvent[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [speechGate, setSpeechGate] = useState<SpeechGateState>({
    top: [],
    consecutiveSpeechCount: 0,
    lastBurstConfidence: null,
    lastBurstAt: null,
  });
  const [session, setSession] = useState<RecordingSession>({
    status: "idle",
    burstId: null,
    wavId: null,
    durationMs: null,
    draftText: null,
    finalText: null,
    provider: null,
    fallback: null,
    confidence: null,
    transcriptLocale: null,
    updatedAt: Date.now(),
  });
  const [runs, setRuns] = useState<RecordingRun[]>([]);
  const [soundConfidencePercent, setSoundConfidencePercent] = useState<number>(() =>
    readStoredSoundConfidencePercent(),
  );
  const pendingSpeechConfidenceRef = useRef<number | null>(null);
  const soundConfidenceThresholdRef = useRef<number>(soundConfidencePercent / 100);

  useEffect(() => {
    soundConfidenceThresholdRef.current = soundConfidencePercent / 100;
    saveStoredSoundConfidencePercent(soundConfidencePercent);
  }, [soundConfidencePercent]);

  useEffect(() => {
    let active = true;
    const handles = AUDIO_EVENT_NAMES.map((eventName) =>
      AmbientAi.addListener(eventName, (event) => {
        if (!active) return;
        const lowConfClassification =
          eventName === "soundClassification" &&
          (() => {
            const top = (event as AmbientEventMap["soundClassification"]).classifications[0];
            return !top || top.confidence < soundConfidenceThresholdRef.current;
          })();
        if (!lowConfClassification) {
          setEvents((prev) => [
            {
              id: Date.now() + prev.length,
              name: eventName,
              receivedAt: Date.now(),
              preview: previewEvent(eventName, event),
            },
            ...prev,
          ].slice(0, 12));
        }

        if (eventName === "soundClassification") {
          const frame = event as AmbientEventMap["soundClassification"];
          const top = frame.classifications[0];
          if (!top || top.confidence < soundConfidenceThresholdRef.current) {
            return;
          }
          const hit = top.label.toLowerCase() === "speech" && top.confidence >= SPEECH_CONFIDENCE_THRESHOLD;
          setSpeechGate((prevGate) => ({
            ...prevGate,
            top: frame.classifications.slice(0, 3),
            consecutiveSpeechCount: hit ? Math.min(prevGate.consecutiveSpeechCount + 1, SPEECH_CONSECUTIVE_FRAMES) : 0,
          }));
        }

        if (eventName === "speechBurst") {
          const burst = event as AmbientEventMap["speechBurst"];
          pendingSpeechConfidenceRef.current = burst.confidence;
          setSpeechGate((prevGate) => ({
            ...prevGate,
            lastBurstConfidence: burst.confidence,
            lastBurstAt: burst.timestamp,
          }));
          setSession((prevSession) => ({
            ...prevSession,
            status: "capturing",
            confidence: burst.confidence,
            updatedAt: Date.now(),
          }));
        }

        if (eventName === "transcriptDraft") {
          const draft = event as AmbientEventMap["transcriptDraft"];
          setSession((prevSession) => ({
            ...prevSession,
            status: "transcribing",
            burstId: draft.burstId,
            wavId: draft.wavId,
            durationMs: draft.durationMs,
            draftText: draft.text,
            transcriptLocale: draft.transcriptLocale ?? null,
            updatedAt: Date.now(),
          }));
        }

        if (eventName === "transcriptReady") {
          const ready = event as AmbientEventMap["transcriptReady"];
          const text = ready.text.trim();
          setSession((prevSession) => ({
            ...prevSession,
            status: text ? "ready" : "empty",
            burstId: ready.burstId,
            wavId: ready.wavId,
            durationMs: ready.durationMs,
            finalText: ready.text,
            provider: ready.provider,
            fallback: ready.fallback,
            transcriptLocale: ready.transcriptLocale ?? null,
            updatedAt: Date.now(),
          }));
          const speechConfidence = pendingSpeechConfidenceRef.current;
          pendingSpeechConfidenceRef.current = null;
          if (text) {
            setRuns((prevRuns) => [{
              id: `${ready.wavId}-${ready.burstId}`,
              burstId: ready.burstId,
              wavId: ready.wavId,
              durationMs: ready.durationMs,
              text: ready.text,
              provider: ready.provider,
              fallback: ready.fallback,
              confidence: speechConfidence,
              transcriptLocale: ready.transcriptLocale ?? null,
              capturedAt: ready.capturedAt,
            }, ...prevRuns].slice(0, 8));
          }
        }

        if (eventName === "audioError") {
          setSession((prevSession) => ({
            ...prevSession,
            status: "error",
            updatedAt: Date.now(),
          }));
        }
      }),
    );

    return () => {
      active = false;
      handles.forEach((handlePromise) => {
        void handlePromise.then((handle) => handle.remove());
      });
    };
  }, []);

  useEffect(() => {
    const storedConfig = readStoredConfig();
    if (!storedConfig) return;
    void AmbientAi.audio.configure(buildConfig(storedConfig)).catch((error) => {
      setStatus(`Saved config failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, []);

  const updateNumber = useCallback((key: AudioConfigNumberField, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  const applyConfig = useCallback(async () => {
    setStatus("Applying config…");
    try {
      await AmbientAi.audio.configure(buildConfig(form));
      saveStoredConfig(form);
      setStatus("Config applied");
    } catch (error) {
      setStatus(`Config failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [form]);

  const refreshState = useCallback(async () => {
    setStatus("Refreshing state…");
    try {
      setState(await AmbientAi.audio.getState());
      setStatus("State refreshed");
    } catch (error) {
      setStatus(`State failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, []);

  const refreshCaptures = useCallback(async () => {
    setStatus("Refreshing captures…");
    try {
      const result = await AmbientAi.audio.listRecentCaptures();
      setCaptures(result.captures);
      setStatus(`Captures refreshed · ${result.captures.length}`);
    } catch (error) {
      setStatus(`Captures failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, []);

  const drainTranscripts = useCallback(async () => {
    setStatus("Draining transcripts…");
    try {
      const transcripts = await AmbientAi.audio.drainPendingTranscripts();
      setDrained(transcripts);
      setStatus(`Drained ${transcripts.length} transcript${transcripts.length === 1 ? "" : "s"}`);
    } catch (error) {
      setStatus(`Drain failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, []);

  const playCapture = useCallback(async (wavId: string) => {
    setStatus(`Playing ${wavId}…`);
    try {
      await AmbientAi.audio.playCapture({ wavId });
      setStatus(`Playing ${wavId}`);
    } catch (error) {
      setStatus(`Play failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, []);

  const stopPlayback = useCallback(async () => {
    setStatus("Stopping playback…");
    try {
      await AmbientAi.audio.stopPlayback();
      setStatus("Playback stopped");
    } catch (error) {
      setStatus(`Stop failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, []);

  return (
    <div className="rounded-xl border border-foreground/10 bg-foreground/[0.03] p-3.5">
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-2">
          <Mic2 size={14} strokeWidth={1.5} className="text-foreground/40" />
          <span className="text-xs font-medium text-foreground/50">Ambient Audio</span>
        </div>
        {status && <span className="text-[10px] text-foreground/40 truncate max-w-[170px]">{status}</span>}
      </div>

      <div className="space-y-2">
        <label className="block text-[10px] font-medium text-foreground/45">
          Cloud mode
          <select
            value={form.cloudMode}
            onChange={(event) => {
              const cloudMode = event.currentTarget.value as AudioConfigForm["cloudMode"];
              setForm((prev) => ({ ...prev, cloudMode }));
            }}
            className="mt-1 w-full rounded-md border border-foreground/10 bg-white/60 px-2 py-1 text-[12px] text-foreground/70 focus:outline-none focus:ring-2 focus:ring-primary/30"
          >
            <option value="off">off</option>
            <option value="devDirect">devDirect</option>
            <option value="proxy">proxy</option>
          </select>
        </label>
        <label className="block text-[10px] font-medium text-foreground/45">
          Recognition language
          <select
            value={form.recognitionLocale}
            onChange={(event) => {
              const recognitionLocale = event.currentTarget.value as AudioRecognitionLocale;
              setForm((prev) => ({ ...prev, recognitionLocale }));
            }}
            className="mt-1 w-full rounded-md border border-foreground/10 bg-white/60 px-2 py-1 text-[12px] text-foreground/70 focus:outline-none focus:ring-2 focus:ring-primary/30"
          >
            <option value="auto">Auto (device order)</option>
            <option value="zh-CN">中文优先 (zh-CN + en-US)</option>
            <option value="en-US">English first (en-US + zh-CN)</option>
          </select>
        </label>
        <label className="block text-[10px] font-medium text-foreground/45">
          Cloud API key
          <input
            type="password"
            value={form.cloudApiKey}
            onChange={(event) => {
              const cloudApiKey = event.currentTarget.value;
              setForm((prev) => ({ ...prev, cloudApiKey }));
            }}
            className="mt-1 w-full rounded-md border border-foreground/10 bg-white/60 px-2 py-1 text-[12px] text-foreground/70 focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </label>
        <label className="block text-[10px] font-medium text-foreground/45">
          Model name
          <input
            type="text"
            value={form.modelName}
            onChange={(event) => {
              const modelName = event.currentTarget.value;
              setForm((prev) => ({ ...prev, modelName }));
            }}
            className="mt-1 w-full rounded-md border border-foreground/10 bg-white/60 px-2 py-1 text-[12px] text-foreground/70 focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <NumberField label="Refine timeout ms" value={form.cloudRefineTimeoutMs} onChange={(value) => updateNumber("cloudRefineTimeoutMs", value)} />
          <NumberField label="Pre-roll ms" value={form.preRollMs} onChange={(value) => updateNumber("preRollMs", value)} />
          <NumberField label="Post-roll ms" value={form.postRollMs} onChange={(value) => updateNumber("postRollMs", value)} />
          <NumberField label="Max burst ms" value={form.maxBurstMs} onChange={(value) => updateNumber("maxBurstMs", value)} />
          <NumberField label="WAV retention ttl ms" value={form.wavRetentionTtlMs} onChange={(value) => updateNumber("wavRetentionTtlMs", value)} />
          <NumberField label="WAV max files" value={form.wavMaxFiles} onChange={(value) => updateNumber("wavMaxFiles", value)} />
        </div>
        <button
          type="button"
          onClick={() => void applyConfig()}
          className="w-full rounded-lg bg-foreground/10 hover:bg-foreground/15 text-foreground/60 text-[11px] font-medium py-1.5 transition-colors"
        >
          Apply audio config
        </button>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <button type="button" onClick={() => void refreshState()} className="rounded-lg bg-foreground/10 hover:bg-foreground/15 text-foreground/60 text-[11px] font-medium py-1.5 transition-colors">
          Refresh state
        </button>
        <button type="button" onClick={() => void refreshCaptures()} className="rounded-lg bg-foreground/10 hover:bg-foreground/15 text-foreground/60 text-[11px] font-medium py-1.5 transition-colors">
          Refresh captures
        </button>
        <button type="button" onClick={() => void drainTranscripts()} className="rounded-lg bg-foreground/10 hover:bg-foreground/15 text-foreground/60 text-[11px] font-medium py-1.5 transition-colors">
          Drain pending transcripts
        </button>
        <button type="button" onClick={() => void stopPlayback()} className="rounded-lg bg-foreground/10 hover:bg-foreground/15 text-foreground/60 text-[11px] font-medium py-1.5 transition-colors">
          Stop playback
        </button>
      </div>

      {state && (
        <p className="mt-2 rounded-lg bg-white/60 border border-foreground/10 px-3 py-2 text-[11px] text-foreground/60 leading-snug">
          {summarizeAudioState(state)}
        </p>
      )}

      <div className="mt-3 rounded-lg bg-white/60 border border-foreground/10 px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-medium text-foreground/40 uppercase tracking-wider">Sound min confidence</span>
          <span className="text-[10px] text-foreground/45 tabular-nums">{soundConfidencePercent}%</span>
        </div>
        <div className="mt-1.5 flex items-center gap-2">
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={soundConfidencePercent}
            onChange={(event) => {
              const next = Number(event.currentTarget.value);
              if (Number.isFinite(next)) {
                setSoundConfidencePercent(Math.min(100, Math.max(0, Math.round(next))));
              }
            }}
            className="flex-1 accent-foreground/60"
          />
          <input
            type="number"
            min={0}
            max={100}
            value={soundConfidencePercent}
            onChange={(event) => {
              const next = Number(event.currentTarget.value);
              if (Number.isFinite(next)) {
                setSoundConfidencePercent(Math.min(100, Math.max(0, Math.round(next))));
              }
            }}
            className="w-14 rounded-md border border-foreground/10 bg-white/60 px-2 py-1 text-[12px] tabular-nums text-foreground/70 focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
        <p className="mt-1 text-[10px] text-foreground/40 leading-snug">
          Drops sound classification events below this confidence from Recent audio events.
        </p>
      </div>

      <div className="mt-3 rounded-lg bg-white/60 border border-foreground/10 px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-medium text-foreground/40 uppercase tracking-wider">Speech gate</span>
          <span className="text-[10px] text-foreground/45">speech &gt;= 60% · 1 frame</span>
        </div>
        <div className="mt-1.5 flex items-center gap-2 text-[11px] text-foreground/60">
          <span className="rounded-md bg-foreground/10 px-1.5 py-0.5 tabular-nums">
            {speechGate.consecutiveSpeechCount} / {SPEECH_CONSECUTIVE_FRAMES}
          </span>
          {speechGate.lastBurstConfidence !== null && (
            <span className="text-foreground/45">
              burst {(speechGate.lastBurstConfidence * 100).toFixed(0)}%
              {speechGate.lastBurstAt ? ` · ${formatTime(speechGate.lastBurstAt)}` : ""}
            </span>
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {speechGate.top.length === 0 ? (
            <span className="text-[11px] text-foreground/30">No classification yet</span>
          ) : speechGate.top.map((entry) => (
            <span key={entry.label} className="rounded-md bg-foreground/10 px-1.5 py-0.5 text-[10px] font-medium text-foreground/55">
              {entry.label} {(entry.confidence * 100).toFixed(0)}%
            </span>
          ))}
        </div>
      </div>

      <div className="mt-3 rounded-lg bg-white/60 border border-foreground/10 px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-medium text-foreground/40 uppercase tracking-wider">Recording session</span>
          <span className="rounded-md bg-foreground/10 px-1.5 py-0.5 text-[10px] font-semibold text-foreground/55">{session.status}</span>
        </div>
        <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] text-foreground/45">
          <span>wav</span><span className="truncate text-foreground/65">{session.wavId ?? "—"}</span>
          <span>burst</span><span className="truncate text-foreground/65">{session.burstId ?? "—"}</span>
          <span>duration</span><span className="text-foreground/65">{session.durationMs === null ? "—" : formatDuration(session.durationMs)}</span>
          <span>provider</span><span className="text-foreground/65">{session.provider ?? "—"}{session.fallback ? " fallback" : ""}</span>
          <span>locale</span><span className="text-foreground/65">{session.transcriptLocale ?? "—"}</span>
        </div>
        <div className="mt-2 space-y-1.5">
          <p className="rounded-md bg-foreground/[0.04] px-2 py-1 text-[11px] text-foreground/60 leading-snug">
            draft: {session.draftText?.trim() ? session.draftText : "—"}
          </p>
          <p className="rounded-md bg-foreground/[0.04] px-2 py-1 text-[11px] text-foreground/60 leading-snug">
            final: {session.finalText?.trim() ? session.finalText : session.status === "empty" ? "Empty transcript" : "—"}
          </p>
        </div>
      </div>

      <div className="mt-3">
        <CollapsibleSection title="Recent recording runs" count={runs.length}>
          {runs.length === 0 ? (
            <p className="text-[11px] text-foreground/30">No recording runs yet</p>
          ) : runs.map((run) => (
            <div key={run.id} className="rounded-lg bg-white/60 border border-foreground/10 px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-medium text-foreground/70 flex-1 truncate">{run.wavId}</span>
                <button
                  type="button"
                  aria-label={`Play ${run.wavId} run`}
                  onClick={() => void playCapture(run.wavId)}
                  className="rounded-md bg-foreground/10 px-2 py-1 text-[10px] font-medium text-foreground/60 hover:bg-foreground/15"
                >
                  Play
                </button>
              </div>
              <p className="mt-1 text-[10px] text-foreground/45 tabular-nums">
                {formatTime(run.capturedAt)} · {formatDuration(run.durationMs)} · {run.provider}{run.transcriptLocale ? ` · ${run.transcriptLocale}` : ""}{run.confidence !== null ? ` · speech ${(run.confidence * 100).toFixed(0)}%` : ""}
              </p>
              <p className="mt-1 text-[11px] text-foreground/60 leading-snug">
                {run.text}
              </p>
            </div>
          ))}
        </CollapsibleSection>
      </div>

      <div className="mt-3">
        <CollapsibleSection title="Recent WAV captures" count={captures.length}>
          {captures.length === 0 ? (
            <p className="text-[11px] text-foreground/30">No captures loaded</p>
          ) : captures.map((capture) => (
            <div key={capture.wavId} className="rounded-lg bg-white/60 border border-foreground/10 px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-medium text-foreground/70 flex-1 truncate">{capture.wavId}</span>
                <button
                  type="button"
                  aria-label={`Play ${capture.wavId}`}
                  onClick={() => void playCapture(capture.wavId)}
                  className="rounded-md bg-foreground/10 px-2 py-1 text-[10px] font-medium text-foreground/60 hover:bg-foreground/15"
                >
                  Play
                </button>
              </div>
              <p className="mt-1 text-[10px] text-foreground/45 tabular-nums">
                {formatTime(capture.capturedAt)} · {formatDuration(capture.durationMs)} · {formatBytes(capture.byteSize)}
              </p>
            </div>
          ))}
        </CollapsibleSection>
      </div>

      <div className="mt-3">
        <CollapsibleSection title="Pending transcript drain" count={drained.length}>
          {drained.length === 0 ? (
            <p className="text-[11px] text-foreground/30">No drained transcripts</p>
          ) : drained.map((transcript) => (
            <p key={`${transcript.wavId}-${transcript.burstId}`} className="rounded-lg bg-white/60 border border-foreground/10 px-3 py-2 text-[11px] text-foreground/60 leading-snug">
              {transcript.wavId}{transcript.transcriptLocale ? ` · ${transcript.transcriptLocale}` : ""} · {transcript.text}
            </p>
          ))}
        </CollapsibleSection>
      </div>

      <div className="mt-3">
        <CollapsibleSection title="Recent audio events" count={events.length}>
          {events.length === 0 ? (
            <p className="text-[11px] text-foreground/30">No audio events yet</p>
          ) : events.map((event) => (
            <div key={event.id} className="rounded-lg bg-white/60 border border-foreground/10 px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-foreground/30 tabular-nums font-mono">{formatTime(event.receivedAt)}</span>
                <span className="text-[10px] font-medium text-foreground/45 bg-foreground/10 px-1.5 py-0.5 rounded-md">{event.name}</span>
              </div>
              <p className="mt-1 text-[11px] text-foreground/60 leading-snug line-clamp-2">{event.preview}</p>
            </div>
          ))}
        </CollapsibleSection>
      </div>

      <div className="mt-3 rounded-lg bg-amber-50/70 border border-amber-200 px-3 py-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-700/80">Background/WAV validation prep</span>
        <ul className="mt-1 list-disc pl-4 text-[10px] leading-relaxed text-amber-800/75">
          <li>Test with screen locked and app backgrounded; confirm audioState resumes after interruptions.</li>
          <li>Verify listed WAV duration and bytes before playback; keep cloud API keys dev-only.</li>
        </ul>
      </div>
    </div>
  );
}
