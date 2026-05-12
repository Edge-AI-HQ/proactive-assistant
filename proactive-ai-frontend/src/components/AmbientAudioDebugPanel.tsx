import { useCallback, useEffect, useRef, useState } from "react";
import { Mic2 } from "lucide-react";
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

type AudioConfigForm = Required<Pick<
  AudioCaptureConfig,
  | "cloudMode"
  | "cloudApiKey"
  | "modelName"
  | "cloudRefineTimeoutMs"
  | "preRollMs"
  | "postRollMs"
  | "maxBurstMs"
  | "wavRetentionTtlMs"
  | "wavMaxFiles"
>> & {
  recognitionLocale: AudioRecognitionLocale;
};

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

const INITIAL_CONFIG: AudioConfigForm = {
  cloudMode: "off",
  recognitionLocale: "auto",
  cloudApiKey: "",
  modelName: "",
  cloudRefineTimeoutMs: 15000,
  preRollMs: 700,
  postRollMs: 1200,
  maxBurstMs: 10000,
  wavRetentionTtlMs: 3600000,
  wavMaxFiles: 12,
};

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

function parseOptionalNumber(value: number): number | undefined {
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function summarizeAudioState(state: AudioState): string {
  return `running: ${state.running} · paused: ${state.paused} · capturing: ${state.capturing} · suppressed: ${state.suppressed}${state.suppressedReason ? ` (${state.suppressedReason})` : ""}`;
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

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block text-[10px] font-medium text-foreground/45">
      {label}
      <input
        type="number"
        min={0}
        value={value}
        onChange={(event) => onChange(event.currentTarget.valueAsNumber)}
        className="mt-1 w-full rounded-md border border-foreground/10 bg-white/60 px-2 py-1 text-[12px] text-foreground/70 focus:outline-none focus:ring-2 focus:ring-primary/30"
      />
    </label>
  );
}

export default function AmbientAudioDebugPanel() {
  const [form, setForm] = useState<AudioConfigForm>(INITIAL_CONFIG);
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
  const pendingSpeechConfidenceRef = useRef<number | null>(null);

  useEffect(() => {
    let active = true;
    const handles = AUDIO_EVENT_NAMES.map((eventName) =>
      AmbientAi.addListener(eventName, (event) => {
        if (!active) return;
        setEvents((prev) => [
          {
            id: Date.now() + prev.length,
            name: eventName,
            receivedAt: Date.now(),
            preview: previewEvent(eventName, event),
          },
          ...prev,
        ].slice(0, 12));

        if (eventName === "soundClassification") {
          const frame = event as AmbientEventMap["soundClassification"];
          const top = frame.classifications[0];
          const hit = top?.label.toLowerCase() === "speech" && top.confidence >= SPEECH_CONFIDENCE_THRESHOLD;
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

  const updateNumber = useCallback((key: keyof AudioConfigForm, value: number) => {
    setForm((prev) => ({ ...prev, [key]: Number.isFinite(value) ? value : 0 }));
  }, []);

  const applyConfig = useCallback(async () => {
    setStatus("Applying config…");
    try {
      await AmbientAi.audio.configure(buildConfig(form));
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
        <span className="text-[10px] font-medium text-foreground/40 uppercase tracking-wider">Recent recording runs</span>
        <div className="mt-1.5 space-y-1.5">
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
                {run.text.trim() ? run.text : "Empty transcript"}
              </p>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-3">
        <span className="text-[10px] font-medium text-foreground/40 uppercase tracking-wider">Recent WAV captures</span>
        <div className="mt-1.5 space-y-1.5">
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
        </div>
      </div>

      <div className="mt-3">
        <span className="text-[10px] font-medium text-foreground/40 uppercase tracking-wider">Pending transcript drain</span>
        <div className="mt-1.5 space-y-1.5">
          {drained.length === 0 ? (
            <p className="text-[11px] text-foreground/30">No drained transcripts</p>
          ) : drained.map((transcript) => (
            <p key={`${transcript.wavId}-${transcript.burstId}`} className="rounded-lg bg-white/60 border border-foreground/10 px-3 py-2 text-[11px] text-foreground/60 leading-snug">
              {transcript.wavId}{transcript.transcriptLocale ? ` · ${transcript.transcriptLocale}` : ""} · {transcript.text}
            </p>
          ))}
        </div>
      </div>

      <div className="mt-3">
        <span className="text-[10px] font-medium text-foreground/40 uppercase tracking-wider">Recent audio events</span>
        <div className="mt-1.5 space-y-1.5">
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
        </div>
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
