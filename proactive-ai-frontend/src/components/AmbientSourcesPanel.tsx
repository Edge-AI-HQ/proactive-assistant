/**
 * AmbientSourcesPanel — user-facing opt-in toggle + DebugPanel inspection.
 *
 * Per V3 migration plan D-5 / Step 3, ambient capture is opt-in. The
 * user's enabled set lives in ``pai_user_settings.ambient_sources``
 * (server side); this panel reads from there via ``useUserSettings``,
 * writes a per-source patch when a toggle flips, and on the same flip
 * starts / stops the matching runtime source locally so the change
 * takes effect immediately.
 *
 * Web platform note: SoundClassifier and VisitMonitor are iOS-only
 * native plugins; their web stubs throw on start. We disable those
 * toggles outside native to avoid confusing failures. Geolocation has
 * a real web implementation and stays enabled.
 */
import { useCallback, useEffect, useState } from "react";
import { Radio } from "lucide-react";
import AmbientAudioDebugPanel from "./AmbientAudioDebugPanel";
import { isNative } from "@/lib/platform";
import { useUserSettings } from "@/hooks/useUserSettings";
import {
  getAmbientRuntime,
  type RuntimeStatus,
  type SourceKey,
  type SourceStatus,
} from "@/services/ambient";

const SOURCE_HINTS: Record<SourceKey, string> = {
  sound_classifier: "iOS only · ~1.5s windows · top-1 label",
  visit: "iOS only · system-detected place arrivals/departures",
  activity: "iOS only · stationary/walking/running/automotive/cycling",
  location: "Continuous GPS watch · 25m delta filter",
};

const NATIVE_ONLY_SOURCES: ReadonlySet<SourceKey> = new Set([
  "sound_classifier",
  "visit",
  "activity",
]);

function formatTime(ts: number | null): string {
  if (!ts) return "\u2014";
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function SourceRow({
  status,
  busy,
  onToggle,
}: {
  status: SourceStatus;
  busy: boolean;
  onToggle: () => void;
}) {
  const nativeOnly = NATIVE_ONLY_SOURCES.has(status.key);
  const disabled = busy || (nativeOnly && !isNative);
  const lastSummary = status.lastEvent?.summary ?? "—";
  const lastTime = status.lastEvent ? formatTime(status.lastEvent.ts) : "";

  return (
    <div className="rounded-lg bg-white/60 border border-foreground/10 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-medium text-foreground/70 flex-1 truncate">
          {status.label}
        </span>
        <button
          onClick={onToggle}
          disabled={disabled}
          className={`text-[10px] font-semibold px-2 py-1 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
            status.enabled
              ? "bg-emerald-500 text-white hover:bg-emerald-600"
              : "bg-foreground/10 text-foreground/60 hover:bg-foreground/15"
          }`}
        >
          {busy ? "..." : status.enabled ? "ON" : "OFF"}
        </button>
      </div>
      <p className="text-[10px] text-foreground/40 mt-1 leading-snug">
        {nativeOnly && !isNative ? "Native only — open in iOS app" : SOURCE_HINTS[status.key]}
      </p>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span className="text-[10px] text-foreground/30 tabular-nums font-mono shrink-0 w-12">
          {lastTime || "—"}
        </span>
        <span className="text-[11px] text-foreground/60 truncate flex-1">
          {lastSummary}
        </span>
        <span className="text-[10px] text-foreground/40 tabular-nums">
          ✓ {status.ingestedCount}
        </span>
      </div>
      {status.lastError && (
        <p className="text-[10px] text-red-500 mt-1 leading-snug">{status.lastError}</p>
      )}
    </div>
  );
}

export default function AmbientSourcesPanel() {
  const [status, setStatus] = useState<RuntimeStatus>(() =>
    getAmbientRuntime().status(),
  );
  const [busyKeys, setBusyKeys] = useState<Set<SourceKey>>(new Set());
  const { settings, patch } = useUserSettings();

  useEffect(() => {
    const rt = getAmbientRuntime();
    return rt.subscribe(() => setStatus(rt.status()));
  }, []);

  // Toggle path: server settings are the single source of truth. We
  // only PATCH here; the reconcile effect below picks up the new
  // ``settings`` value and starts/stops the runtime source. This avoids
  // the double-write race that exists when both toggle and effect drive
  // the runtime.
  const toggle = useCallback(async (key: SourceKey, currentlyEnabled: boolean) => {
    setBusyKeys((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
    try {
      await patch({
        ambientSources: { [key]: { enabled: !currentlyEnabled } },
      });
    } finally {
      setBusyKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, [patch]);

  // No reconcile effect here — App.tsx's startAmbientUpload effect is
  // the sole runtime driver and runs whenever the user's opt-in set
  // changes, regardless of whether DebugPanel happens to be mounted.
  // Toggle above just PATCHes; settings → App.tsx → runtime.

  const flush = useCallback(async () => {
    await getAmbientRuntime().flush();
  }, []);

  return (
    <div className="rounded-xl border border-foreground/10 bg-foreground/[0.03] p-3.5">
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-2">
          <Radio size={14} strokeWidth={1.5} className="text-foreground/40" />
          <span className="text-xs font-medium text-foreground/50">
            Ambient Sources
          </span>
        </div>
        <span className="text-[10px] text-foreground/40 tabular-nums">
          buf {status.bufferSize} · outbox {status.outboxPendingCount} ({status.outboxMode}) · ingested {status.totalIngested}
          {status.totalIngestErrors > 0
            ? ` · err ${status.totalIngestErrors}`
            : ""}
        </span>
      </div>
      <div className="space-y-2">
        {status.sources.map((src) => (
          <SourceRow
            key={src.key}
            status={src}
            busy={busyKeys.has(src.key)}
            onToggle={() => {
              void toggle(src.key, src.enabled);
            }}
          />
        ))}
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <button
          onClick={() => void flush()}
          disabled={status.bufferSize === 0}
          className="flex-1 rounded-lg bg-foreground/10 hover:bg-foreground/15 text-foreground/60 text-[11px] font-medium py-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Flush buffer now
        </button>
        <span className="text-[10px] text-foreground/40 tabular-nums shrink-0">
          last drain {formatTime(status.lastDrainTs)}
        </span>
      </div>
      <p className="text-[10px] text-foreground/35 mt-1.5">
        last ok {formatTime(status.lastSuccessfulDrainTs)} · last outbox flush {formatTime(status.lastFlushTs)}
      </p>
      {status.lastIngestError && (
        <p className="text-[11px] text-red-500 mt-2 leading-snug">
          ingest: {status.lastIngestError}
        </p>
      )}
      <div className="mt-3">
        <AmbientAudioDebugPanel />
      </div>
    </div>
  );
}
