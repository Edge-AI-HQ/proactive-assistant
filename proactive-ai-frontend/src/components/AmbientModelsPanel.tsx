/**
 * AmbientModelsPanel — on-device small-model manager for ambient.
 *
 * Two independent sections, one per kind (ASR · whisper.cpp / LLM ·
 * llama.cpp). The dropdown in each section IS the active model for that
 * kind: changing it persists to localStorage and runtime consumers pick
 * the new id up on the next call. No separate "use this for summaries"
 * step.
 *
 * Verification is intentionally lazy: `selectedModelReadiness` in
 * `services/ambient/timeline/models.ts` auto-runs `verifyModel` before the
 * first generation if a profile has never been verified. The manual
 * `Run verify` link in the Advanced disclosure is a debug override only.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Cpu, CheckCircle2, XCircle, Trash2, Loader2, ChevronDown } from "lucide-react";
import {
  AmbientAi,
  type ModelDownloadProgressEvent,
  type ModelDownloadStatus,
  type ModelKind,
  type ModelMirror,
  type ModelProfile,
  type ModelVerifyResult,
} from "@pin/capacitor-ambient-ai";
import {
  clearSelectedAmbientAsrModelId,
  clearSelectedAmbientSummaryModelId,
  getSelectedAmbientAsrModelId,
  getSelectedAmbientSummaryModelId,
  setSelectedAmbientAsrModelId,
  setSelectedAmbientSummaryModelId,
} from "@/services/ambient/models-selection";

type StatusById = Record<string, ModelDownloadStatus>;

const MIRROR_OPTIONS: { value: ModelMirror; label: string }[] = [
  { value: "hf-mirror", label: "hf-mirror.com (CN)" },
  { value: "hf", label: "huggingface.co" },
];
const MIRROR_STORAGE_KEY = "pinai:ambient-models-preferred-mirror";

const KIND_LABEL: Record<ModelKind, string> = {
  asr: "ASR · whisper.cpp",
  llm: "LLM · llama.cpp",
};

function readStoredMirror(): ModelMirror {
  if (typeof window === "undefined") return "hf-mirror";
  try {
    const raw = window.localStorage.getItem(MIRROR_STORAGE_KEY);
    return raw === "hf" || raw === "hf-mirror" ? raw : "hf-mirror";
  } catch {
    return "hf-mirror";
  }
}

function storeMirror(value: ModelMirror): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MIRROR_STORAGE_KEY, value);
  } catch {
    // ignore — debug surface only
  }
}

function formatBytes(value: number): string {
  if (!value || value <= 0) return "—";
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(0)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatPercent(written: number, total: number): string {
  if (!total) return "0%";
  return `${Math.min(100, Math.round((written / total) * 100))}%`;
}

const KIND_PERSISTERS: Record<ModelKind, {
  read: () => string | null;
  write: (id: string) => void;
  clear: () => void;
}> = {
  asr: {
    read: getSelectedAmbientAsrModelId,
    write: setSelectedAmbientAsrModelId,
    clear: clearSelectedAmbientAsrModelId,
  },
  llm: {
    read: getSelectedAmbientSummaryModelId,
    write: setSelectedAmbientSummaryModelId,
    clear: clearSelectedAmbientSummaryModelId,
  },
};

interface SectionProps {
  kind: ModelKind;
  profiles: ModelProfile[];
  statusById: StatusById;
  mirror: ModelMirror;
  busy: boolean;
  setBusy: (value: boolean) => void;
  onError: (message: string | null) => void;
  refresh: () => Promise<void>;
  setStatusById: React.Dispatch<React.SetStateAction<StatusById>>;
  showAdvanced: boolean;
}

function ModelSection({
  kind,
  profiles,
  statusById,
  mirror,
  busy,
  setBusy,
  onError,
  refresh,
  setStatusById,
  showAdvanced,
}: SectionProps) {
  const persister = KIND_PERSISTERS[kind];

  const [selectedId, setSelectedId] = useState<string | null>(() => {
    const stored = persister.read();
    if (stored && profiles.some((p) => p.id === stored)) return stored;
    return profiles[0]?.id ?? null;
  });

  useEffect(() => {
    setSelectedId((prev) => {
      if (prev && profiles.some((p) => p.id === prev)) return prev;
      const stored = persister.read();
      if (stored && profiles.some((p) => p.id === stored)) return stored;
      return profiles[0]?.id ?? null;
    });
  }, [profiles, persister]);

  const handleSelect = useCallback((id: string) => {
    setSelectedId(id);
    persister.write(id);
  }, [persister]);

  const selected = useMemo(
    () => profiles.find((p) => p.id === selectedId) ?? null,
    [profiles, selectedId],
  );
  const selectedStatus = selected ? statusById[selected.id] : undefined;
  const state = selectedStatus?.state ?? "absent";
  const present = state === "present" || state === "verifying";
  const downloading = state === "downloading" || state === "paused";
  const failed = state === "failed";
  const verifying = state === "verifying";
  const verifyOk = selectedStatus?.lastVerifyResult === "ok";
  const verifyFail = selectedStatus?.lastVerifyResult === "fail";

  const downloadLabel = downloading
    ? "Cancel"
    : present
      ? "Re-download"
      : failed
        ? "Retry"
        : "Download";

  const handleDownloadOrCancel = useCallback(async () => {
    if (!selected) return;
    setBusy(true);
    onError(null);
    try {
      if (downloading) {
        await AmbientAi.models.cancelDownload({ id: selected.id });
      } else {
        await AmbientAi.models.startDownload({
          id: selected.id,
          preferredMirror: mirror,
        });
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [selected, downloading, mirror, setBusy, onError]);

  const handleVerify = useCallback(async () => {
    if (!selected) return;
    setBusy(true);
    onError(null);
    setStatusById((prev) => {
      const current = prev[selected.id];
      if (!current) return prev;
      return { ...prev, [selected.id]: { ...current, state: "verifying" } };
    });
    try {
      const result: ModelVerifyResult = await AmbientAi.models.verifyModel({
        id: selected.id,
      });
      setStatusById((prev) => {
        const current = prev[selected.id];
        if (!current) return prev;
        return {
          ...prev,
          [selected.id]: {
            ...current,
            state: "present",
            lastVerifiedAt: Date.now(),
            lastVerifyResult: result.ok ? "ok" : "fail",
            lastVerifyOutput: result.output,
            lastVerifyError: result.errorMessage,
          },
        };
      });
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [selected, setBusy, onError, setStatusById]);

  const handleDelete = useCallback(async () => {
    if (!selected) return;
    setBusy(true);
    onError(null);
    try {
      await AmbientAi.models.deleteModel({ id: selected.id });
      const wasActive = persister.read() === selected.id;
      if (wasActive) {
        const fallback = profiles.find(
          (p) => p.id !== selected.id && statusById[p.id]?.state === "present",
        );
        if (fallback) {
          persister.write(fallback.id);
          setSelectedId(fallback.id);
        } else {
          persister.clear();
          const firstOther = profiles.find((p) => p.id !== selected.id);
          setSelectedId(firstOther?.id ?? null);
        }
      }
      await refresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [selected, profiles, statusById, persister, refresh, setBusy, onError]);

  if (profiles.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <label className="block text-[10px] font-medium text-foreground/45">
        {KIND_LABEL[kind]} · active
      </label>
      <select
        aria-label={`Active ${kind} model`}
        value={selected?.id ?? ""}
        disabled={busy || downloading}
        onChange={(e) => handleSelect(e.currentTarget.value)}
        className="w-full rounded-md border border-foreground/15 bg-white/70 px-2 py-1.5 text-[12px] text-foreground/80 focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {profiles.map((p) => {
          const s = statusById[p.id];
          const dot =
            s?.state === "present" || s?.state === "verifying"
              ? "● "
              : s?.state === "downloading" || s?.state === "paused"
                ? "↓ "
                : "";
          return (
            <option key={p.id} value={p.id}>
              {dot}{p.displayName} · {formatBytes(p.approxBytes)}
            </option>
          );
        })}
      </select>

      {selected ? (
        <>
          <p className="text-[10px] text-foreground/45 leading-snug break-words">
            {selected.repo} / {selected.file}
            {selected.notes ? ` · ${selected.notes}` : ""}
          </p>

          {downloading && selectedStatus ? (
            <div className="space-y-1">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
                <div
                  className="h-full bg-foreground/60 transition-[width] duration-300"
                  style={{
                    width: formatPercent(
                      selectedStatus.bytesWritten,
                      selectedStatus.bytesTotal || selected.approxBytes,
                    ),
                  }}
                />
              </div>
              <p className="text-[10px] tabular-nums text-foreground/45">
                {formatBytes(selectedStatus.bytesWritten)} /
                {" "}
                {formatBytes(selectedStatus.bytesTotal || selected.approxBytes)}
                {" · "}
                {formatPercent(
                  selectedStatus.bytesWritten,
                  selectedStatus.bytesTotal || selected.approxBytes,
                )}
                {selectedStatus.mirrorInUse ? ` · via ${selectedStatus.mirrorInUse}` : ""}
              </p>
            </div>
          ) : null}

          {present && selectedStatus?.sizeOnDisk ? (
            <p className="text-[10px] tabular-nums text-foreground/45">
              on disk: {formatBytes(selectedStatus.sizeOnDisk)}
            </p>
          ) : null}

          {failed && selectedStatus?.errorMessage ? (
            <p className="text-[10px] text-red-500 leading-snug">
              {selectedStatus.errorMessage}
            </p>
          ) : null}

          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={handleDownloadOrCancel}
              disabled={busy && !downloading}
              className="flex-1 rounded-md bg-foreground text-background text-[11px] font-semibold py-1.5 transition-colors hover:bg-foreground/85 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {downloadLabel}
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={!present || busy}
              aria-label={`Delete ${selected.displayName}`}
              className="rounded-md border border-foreground/15 text-red-500 hover:bg-red-50 disabled:opacity-40 px-2 py-1.5"
            >
              <Trash2 size={12} strokeWidth={1.75} />
            </button>
          </div>

          {showAdvanced ? (
            <div className="pt-1.5 border-t border-foreground/10 mt-1.5 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-foreground/45">
                  Manual verify (runtime auto-verifies on first use)
                </span>
                <button
                  type="button"
                  onClick={handleVerify}
                  disabled={!present || busy || verifying}
                  className="text-[10px] text-foreground/70 underline underline-offset-2 hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed disabled:no-underline inline-flex items-center gap-1"
                >
                  {verifying ? <Loader2 size={10} className="animate-spin" /> : null}
                  {verifying ? "Verifying…" : "Run verify"}
                </button>
              </div>
              {(verifyOk || verifyFail) && selectedStatus ? (
                <div
                  className={`flex items-start gap-1.5 text-[10px] leading-snug ${
                    verifyOk ? "text-emerald-700" : "text-red-500"
                  }`}
                >
                  {verifyOk ? (
                    <CheckCircle2 size={11} strokeWidth={1.75} className="mt-0.5 shrink-0" />
                  ) : (
                    <XCircle size={11} strokeWidth={1.75} className="mt-0.5 shrink-0" />
                  )}
                  <span className="break-words">
                    {verifyOk
                      ? `verified${selectedStatus.lastVerifyOutput ? `: ${selectedStatus.lastVerifyOutput}` : ""}`
                      : `verify failed${selectedStatus.lastVerifyError ? `: ${selectedStatus.lastVerifyError}` : ""}`}
                  </span>
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export default function AmbientModelsPanel() {
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [statusById, setStatusById] = useState<StatusById>({});
  const [mirror, setMirror] = useState<ModelMirror>(() => readStoredMirror());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const { profiles: list, statuses } = await AmbientAi.models.list();
      setProfiles(list);
      const next: StatusById = {};
      for (const s of statuses) next[s.id] = s;
      setStatusById(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let active = true;
    const handles: Promise<{ remove: () => Promise<void> }>[] = [];
    const onEvent = (evt: ModelDownloadProgressEvent) => {
      if (!active) return;
      setStatusById((prev) => ({ ...prev, [evt.id]: evt }));
    };
    handles.push(AmbientAi.addListener("modelDownloadProgress", onEvent));
    handles.push(AmbientAi.addListener("modelDownloadDone", onEvent));
    return () => {
      active = false;
      handles.forEach((h) => {
        void h.then((handle) => handle.remove());
      });
    };
  }, []);

  const handleMirrorChange = useCallback((value: ModelMirror) => {
    setMirror(value);
    storeMirror(value);
  }, []);

  const asrProfiles = useMemo(() => profiles.filter((p) => p.kind === "asr"), [profiles]);
  const llmProfiles = useMemo(() => profiles.filter((p) => p.kind === "llm"), [profiles]);

  return (
    <div className="rounded-xl border border-foreground/10 bg-foreground/[0.03] p-3.5 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Cpu size={14} strokeWidth={1.5} className="text-foreground/40" />
          <span className="text-xs font-medium text-foreground/50">Ambient Models</span>
        </div>
        <label className="text-[10px] font-medium text-foreground/45 inline-flex items-center gap-1.5">
          <span>Mirror</span>
          <select
            value={mirror}
            onChange={(e) => handleMirrorChange(e.currentTarget.value as ModelMirror)}
            aria-label="Preferred mirror"
            className="rounded-md border border-foreground/10 bg-white/60 px-2 py-0.5 text-[11px] text-foreground/70 focus:outline-none focus:ring-2 focus:ring-primary/30"
          >
            {MIRROR_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </label>
      </div>

      {profiles.length === 0 ? (
        <p className="text-[11px] text-foreground/30 py-3 text-center">
          {error ? `models.list failed: ${error}` : "Loading manifest…"}
        </p>
      ) : (
        <>
          <ModelSection
            kind="asr"
            profiles={asrProfiles}
            statusById={statusById}
            mirror={mirror}
            busy={busy}
            setBusy={setBusy}
            onError={setError}
            refresh={refresh}
            setStatusById={setStatusById}
            showAdvanced={advancedOpen}
          />
          <ModelSection
            kind="llm"
            profiles={llmProfiles}
            statusById={statusById}
            mirror={mirror}
            busy={busy}
            setBusy={setBusy}
            onError={setError}
            refresh={refresh}
            setStatusById={setStatusById}
            showAdvanced={advancedOpen}
          />
        </>
      )}

      <button
        type="button"
        onClick={() => setAdvancedOpen((open) => !open)}
        aria-expanded={advancedOpen}
        className="inline-flex items-center gap-1 text-[10px] text-foreground/45 hover:text-foreground/70"
      >
        <ChevronDown
          size={11}
          strokeWidth={1.75}
          className={`transition-transform ${advancedOpen ? "rotate-0" : "-rotate-90"}`}
        />
        Advanced
      </button>

      <p className="text-[10px] text-foreground/40 leading-snug">
        Auto fallback: {mirror === "hf-mirror" ? "hf-mirror → huggingface" : "huggingface → hf-mirror"} on first HTTP / network error. The active selection in each dropdown is what ambient uses; runtime auto-verifies on first use.
      </p>

      {error && profiles.length > 0 && (
        <p className="text-[10px] text-red-500 leading-snug">{error}</p>
      )}
    </div>
  );
}
