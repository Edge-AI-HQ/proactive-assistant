import { useCallback, useEffect, useMemo, useState } from "react";
import { Radio, ShieldCheck } from "lucide-react";
import { isNative } from "@/lib/platform";
import { useUserSettings, type AmbientSourceConsent } from "@/hooks/useUserSettings";
import {
  ALL_SOURCE_KEYS,
  type SourceKey,
} from "@/services/ambient/keys";
import { loadAmbientRuntime } from "@/services/ambient/runtime-client";
import type { RuntimeStatus, SourceStatus } from "@/services/ambient";

const SOURCE_ORDER = new Map<SourceKey, number>(
  ALL_SOURCE_KEYS.map((key, index) => [key, index]),
);

const SOURCE_META: Record<SourceKey, {
  label: string;
  permission: string;
  hint: string;
  nativeOnly: boolean;
}> = {
  sound_classifier: {
    label: "Sound Classifier",
    permission: "Microphone",
    hint: "Detects speech, music, and ambient sound labels on device.",
    nativeOnly: true,
  },
  visit: {
    label: "Place Visits",
    permission: "Location",
    hint: "Uses iOS visit monitoring for arrival and departure signals.",
    nativeOnly: true,
  },
  activity: {
    label: "Motion Activity",
    permission: "Motion",
    hint: "Tracks walking, running, cycling, driving, and stationary context.",
    nativeOnly: true,
  },
  location: {
    label: "Geolocation",
    permission: "Location",
    hint: "Records coarse movement changes with a 25m delta filter.",
    nativeOnly: false,
  },
  health: {
    label: "HealthKit",
    permission: "Health",
    hint: "Reads foreground snapshots for steps, sleep, and heart rate.",
    nativeOnly: true,
  },
  calendar: {
    label: "Calendar",
    permission: "Calendar",
    hint: "Uploads current and upcoming calendar context into ambient windows.",
    nativeOnly: true,
  },
  focus: {
    label: "Focus",
    permission: "Notifications",
    hint: "Tracks Focus/DND status as low-frequency ambient context.",
    nativeOnly: true,
  },
  audio_route: {
    label: "Audio Route",
    permission: "Audio Session",
    hint: "Observes CarPlay, Bluetooth, speaker, and headphone route changes.",
    nativeOnly: true,
  },
  device_state: {
    label: "Device State",
    permission: "Device",
    hint: "Reports low power, thermal, or low battery states that affect collection quality.",
    nativeOnly: true,
  },
};

interface SourceRowState {
  key: SourceKey;
  label: string;
  permission: string;
  hint: string;
  nativeOnly: boolean;
  enabled: boolean;
  running: boolean;
  busy: boolean;
  lastEvent: SourceStatus["lastEvent"];
  ingestedCount: number;
  lastError: string | null;
}

function isSourceKey(value: string): value is SourceKey {
  return ALL_SOURCE_KEYS.includes(value as SourceKey);
}

function enabledKeysFromConsent(
  ambientSources: Record<string, AmbientSourceConsent | null | undefined> | null | undefined,
): SourceKey[] {
  return Object.entries(ambientSources ?? {})
    .filter(([key, consent]) => isSourceKey(key) && consent?.enabled === true)
    .map(([key]) => key as SourceKey)
    .sort((a, b) => (SOURCE_ORDER.get(a) ?? 0) - (SOURCE_ORDER.get(b) ?? 0));
}

function formatTime(ts: number | null): string {
  if (!ts) return "\u2014";
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function AmbientSourceRow({
  row,
  onToggle,
}: {
  row: SourceRowState;
  onToggle: (key: SourceKey, currentlyEnabled: boolean) => void;
}) {
  const disabled = row.busy || (row.nativeOnly && !isNative);
  const stateLabel = row.busy ? "Saving" : row.enabled ? "On" : "Off";

  return (
    <div className="rounded-2xl border border-foreground/10 bg-background/45 px-3.5 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="text-[13px] font-semibold text-foreground leading-tight">
              {row.label}
            </p>
            <span className="rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[10px] font-medium text-foreground/50">
              {row.permission}
            </span>
            {row.running && (
              <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                running
              </span>
            )}
          </div>
          <p className="mt-1 text-[11.5px] leading-snug text-foreground/52">
            {row.nativeOnly && !isNative ? "Native only — open in the iOS app to enable." : row.hint}
          </p>
        </div>
        <button
          type="button"
          onClick={() => onToggle(row.key, row.enabled)}
          disabled={disabled}
          aria-label={`${row.enabled ? "Disable" : "Enable"} ${row.label}`}
          className={`min-h-11 min-w-[64px] rounded-full px-3 text-[11px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${row.enabled
            ? "bg-foreground text-background hover:opacity-90"
            : "bg-foreground/[0.08] text-foreground/58 hover:bg-foreground/[0.12]"
            }`}
        >
          {stateLabel}
        </button>
      </div>

      <div className="mt-2.5 flex items-center gap-2 text-[10.5px] text-foreground/40">
        <span className="font-mono tabular-nums">{formatTime(row.lastEvent?.ts ?? null)}</span>
        <span className="min-w-0 flex-1 truncate">{row.lastEvent?.summary ?? "No local event yet"}</span>
        <span className="font-mono tabular-nums">✓ {row.ingestedCount}</span>
      </div>
      {row.lastError && (
        <p className="mt-1.5 text-[11px] leading-snug text-red-500">{row.lastError}</p>
      )}
    </div>
  );
}

export default function AmbientSourceControlsPanel() {
  const { settings, loading, error, patch } = useUserSettings();
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null);
  const [busyKeys, setBusyKeys] = useState<Set<SourceKey>>(new Set());

  useEffect(() => {
    if (!isNative) return;

    let mounted = true;
    let unsubscribe: (() => void) | undefined;
    void loadAmbientRuntime().then((runtime) => {
      if (!mounted) return;
      const update = () => {
        if (mounted) setRuntimeStatus(runtime.status());
      };
      update();
      unsubscribe = runtime.subscribe(update);
    }).catch(() => {
      if (mounted) setRuntimeStatus(null);
    });

    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, []);

  const enabledKeys = useMemo(
    () => enabledKeysFromConsent(settings?.ambientSources),
    [settings?.ambientSources],
  );

  const rows = useMemo<SourceRowState[]>(() => {
    const runtimeByKey = new Map<SourceKey, SourceStatus>(
      (runtimeStatus?.sources ?? []).map((source) => [source.key, source]),
    );
    const enabled = new Set(enabledKeys);

    return ALL_SOURCE_KEYS.map((key) => {
      const meta = SOURCE_META[key];
      const runtime = runtimeByKey.get(key);
      return {
        key,
        label: runtime?.label ?? meta.label,
        permission: meta.permission,
        hint: meta.hint,
        nativeOnly: meta.nativeOnly,
        enabled: enabled.has(key),
        running: runtime?.enabled === true,
        busy: busyKeys.has(key),
        lastEvent: runtime?.lastEvent ?? null,
        ingestedCount: runtime?.ingestedCount ?? 0,
        lastError: runtime?.lastError ?? null,
      };
    });
  }, [busyKeys, enabledKeys, runtimeStatus?.sources]);

  const toggle = useCallback(async (key: SourceKey, currentlyEnabled: boolean) => {
    setBusyKeys((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });

    try {
      const updated = await patch({
        ambientSources: { [key]: { enabled: !currentlyEnabled } },
      });
      if (!updated || !isNative) return;

      const enabledSources = enabledKeysFromConsent(updated.ambientSources);
      try {
        const runtime = await loadAmbientRuntime();
        await runtime.reconcileEnabledSources(enabledSources);
        setRuntimeStatus(runtime.status());
      } catch {
        // Runtime records per-source failures; settings consent is still saved.
      }
    } finally {
      setBusyKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, [patch]);

  const flush = useCallback(async () => {
    if (!isNative) return;
    const runtime = await loadAmbientRuntime();
    await runtime.flush();
    setRuntimeStatus(runtime.status());
  }, []);

  return (
    <section className="glass-card-strong p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-foreground/[0.06] text-foreground/60">
            <Radio size={15} strokeWidth={1.8} />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <h2 className="text-base font-semibold text-foreground">
                Permissions & sources
              </h2>
              <ShieldCheck size={13} strokeWidth={1.8} className="text-foreground/42" />
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-foreground/55">
              Pick which ambient signals PIN AI may observe.
            </p>
          </div>
        </div>
        <span className="shrink-0 rounded-full bg-foreground/[0.06] px-2 py-1 text-[10px] font-medium text-foreground/45">
          {enabledKeys.length} on
        </span>
      </div>

      {loading ? (
        <div className="rounded-xl border border-foreground/10 bg-foreground/[0.03] p-3 text-[11px] text-foreground/45">
          Loading ambient permissions…
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <AmbientSourceRow
              key={row.key}
              row={row}
              onToggle={(sourceKey, enabled) => {
                void toggle(sourceKey, enabled);
              }}
            />
          ))}
        </div>
      )}

      {runtimeStatus && (
        <div className="rounded-xl border border-foreground/8 bg-foreground/[0.025] px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10.5px] text-foreground/42 tabular-nums">
              buf {runtimeStatus.bufferSize} · outbox {runtimeStatus.outboxPendingCount} · ingested {runtimeStatus.totalIngested}
              {runtimeStatus.totalIngestErrors > 0 ? ` · err ${runtimeStatus.totalIngestErrors}` : ""}
            </p>
            <button
              type="button"
              onClick={() => void flush()}
              disabled={runtimeStatus.bufferSize === 0}
              className="min-h-10 rounded-lg bg-foreground/[0.08] px-3 text-[10.5px] font-medium text-foreground/55 transition-colors hover:bg-foreground/[0.12] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Flush
            </button>
          </div>
          <p className="mt-1 text-[10px] text-foreground/35">
            last ok {formatTime(runtimeStatus.lastSuccessfulDrainTs)} · last drain {formatTime(runtimeStatus.lastDrainTs)}
          </p>
          {runtimeStatus.lastIngestError && (
            <p className="mt-1.5 text-[11px] leading-snug text-red-500">
              ingest: {runtimeStatus.lastIngestError}
            </p>
          )}
        </div>
      )}

      {error && (
        <p className="text-[11px] leading-snug text-red-500">{error}</p>
      )}
    </section>
  );
}
