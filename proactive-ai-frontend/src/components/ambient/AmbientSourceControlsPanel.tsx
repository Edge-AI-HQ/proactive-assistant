import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Radio, ShieldCheck } from "lucide-react";
import { isNative } from "@/lib/platform";
import { useUserSettings, type AmbientSourceConsent } from "@pin-ai/state";
import { setPersistedAmbientEnabled } from "@/services/ambient/enabled-state";
import {
  ALL_SOURCE_KEYS,
  type SourceKey,
} from "@/services/ambient/keys";
import { loadAmbientRuntime } from "@/services/ambient/runtime-client";
import type { RuntimeStatus, SourceStatus } from "@/services/ambient";
import { Text } from "@pin-ai/ui-web";

const SOURCE_ORDER = new Map<SourceKey, number>(
  ALL_SOURCE_KEYS.map((key, index) => [key, index]),
);

// label/permission/hint live in locales/en/ambient.json under
// `sources.meta.<SourceKey>` — resolved through i18n at render time.
const SOURCE_NATIVE_ONLY: Record<SourceKey, boolean> = {
  sound_classifier: true,
  visit: true,
  activity: true,
  location: false,
  health: true,
  calendar: true,
  focus: true,
  audio_route: true,
  device_state: true,
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
  const { t } = useTranslation("ambient");
  const disabled = row.busy || (row.nativeOnly && !isNative);
  const stateLabel = row.busy
    ? t("sources.stateSaving")
    : row.enabled
      ? t("sources.stateOn")
      : t("sources.stateOff");

  return (
    <div className="rounded-2xl border border-foreground/10 bg-background/45 px-3.5 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Text variant="bodySm" weight="semibold" className="block text-foreground leading-tight">
              {row.label}
            </Text>
            <Text variant="micro" weight="medium" className="rounded-full bg-foreground/[0.06] px-2 py-0.5 text-foreground/50">
              {row.permission}
            </Text>
            {row.running && (
              <Text variant="micro" weight="semibold" className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-emerald-700">
                {t("sources.running")}
              </Text>
            )}
          </div>
          <Text variant="label" className="block mt-1 leading-snug text-foreground/52">
            {row.nativeOnly && !isNative ? t("sources.nativeOnly") : row.hint}
          </Text>
        </div>
        <button
          type="button"
          onClick={() => onToggle(row.key, row.enabled)}
          disabled={disabled}
          aria-label={t(row.enabled ? "sources.disableAria" : "sources.enableAria", { label: row.label })}
          className={`min-h-11 min-w-[64px] rounded-full px-3 text-caption font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${row.enabled
            ? "bg-foreground text-background hover:opacity-90"
            : "bg-foreground/[0.08] text-foreground/58 hover:bg-foreground/[0.12]"
            }`}
        >
          {stateLabel}
        </button>
      </div>

      <div className="mt-2.5 flex items-center gap-2 text-micro text-foreground/40">
        <span className="font-mono tabular-nums">{formatTime(row.lastEvent?.ts ?? null)}</span>
        <span className="min-w-0 flex-1 truncate">{row.lastEvent?.summary ?? t("sources.noLocalEvent")}</span>
        <span className="font-mono tabular-nums">✓ {row.ingestedCount}</span>
      </div>
      {row.lastError && (
        <Text variant="caption" className="block mt-1.5 leading-snug text-red-500">{row.lastError}</Text>
      )}
    </div>
  );
}

export default function AmbientSourceControlsPanel() {
  const { t } = useTranslation("ambient");
  const { settings, loading, error, patch } = useUserSettings();
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null);
  const [busyKeys, setBusyKeys] = useState<Set<SourceKey>>(new Set());
  const [bulkEnabling, setBulkEnabling] = useState(false);

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
      const runtime = runtimeByKey.get(key);
      return {
        key,
        label: runtime?.label ?? t(`sources.meta.${key}.label`),
        permission: t(`sources.meta.${key}.permission`),
        hint: t(`sources.meta.${key}.hint`),
        nativeOnly: SOURCE_NATIVE_ONLY[key],
        enabled: enabled.has(key),
        running: runtime?.enabled === true,
        busy: busyKeys.has(key),
        lastEvent: runtime?.lastEvent ?? null,
        ingestedCount: runtime?.ingestedCount ?? 0,
        lastError: runtime?.lastError ?? null,
      };
    });
  }, [busyKeys, enabledKeys, runtimeStatus?.sources, t]);

  const enableableKeys = useMemo(
    () => rows
      .filter((row) => !(row.nativeOnly && !isNative))
      .map((row) => row.key),
    [rows],
  );
  const allEnableableEnabled = enableableKeys.length > 0
    && enableableKeys.every((key) => enabledKeys.includes(key));

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
      if (!updated) return;

      // per-device gate: keep the local opt-in flag in sync with this
      // device's source consent so App.tsx's boot gate and the master
      // switch agree — enabling any source opts this device in; disabling
      // the last one opts back out. (useAmbientToggle writes the same flag.)
      const enabledSources = enabledKeysFromConsent(updated.ambientSources);
      setPersistedAmbientEnabled(enabledSources.length > 0);
      if (!isNative) return;

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

  const enableAll = useCallback(async () => {
    if (enableableKeys.length === 0 || allEnableableEnabled) return;

    setBulkEnabling(true);
    setBusyKeys((prev) => {
      const next = new Set(prev);
      enableableKeys.forEach((key) => next.add(key));
      return next;
    });

    try {
      const ambientSources: Record<string, AmbientSourceConsent> = {};
      enableableKeys.forEach((key) => {
        ambientSources[key] = { enabled: true };
      });

      const updated = await patch({ ambientSources });
      if (!updated) return;

      const enabledSources = enabledKeysFromConsent(updated.ambientSources);
      setPersistedAmbientEnabled(enabledSources.length > 0);
      if (!isNative) return;

      try {
        const runtime = await loadAmbientRuntime();
        await runtime.reconcileEnabledSources(enabledSources);
        setRuntimeStatus(runtime.status());
      } catch {
        // Runtime records per-source failures; settings consent is still saved.
      }
    } finally {
      setBulkEnabling(false);
      setBusyKeys((prev) => {
        const next = new Set(prev);
        enableableKeys.forEach((key) => next.delete(key));
        return next;
      });
    }
  }, [allEnableableEnabled, enableableKeys, patch]);

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
                {t("sources.title")}
              </h2>
              <ShieldCheck size={13} strokeWidth={1.8} className="text-foreground/42" />
            </div>
            <Text variant="label" className="block mt-1 leading-relaxed text-foreground/55">
              {t("sources.subtitle")}
            </Text>
          </div>
        </div>
        <Text variant="micro" weight="medium" className="shrink-0 rounded-full bg-foreground/[0.06] px-2 py-1 text-foreground/45">
          {t("sources.enabledCount", { n: enabledKeys.length })}
        </Text>
      </div>

      <button
        type="button"
        onClick={() => void enableAll()}
        disabled={loading || bulkEnabling || allEnableableEnabled || enableableKeys.length === 0}
        aria-label={t("sources.enableAllAria")}
        className="inline-flex min-h-10 w-full items-center justify-center gap-1.5 rounded-xl bg-foreground px-3 text-label font-semibold text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <CheckCircle2 size={14} strokeWidth={2} />
        {bulkEnabling ? t("sources.enabling") : allEnableableEnabled ? t("sources.allOn") : t("sources.enableAll")}
      </button>

      {loading ? (
        <Text variant="caption" className="block rounded-xl border border-foreground/10 bg-foreground/[0.03] p-3 text-foreground/45">
          {t("sources.loadingPermissions")}
        </Text>
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
            <Text variant="caption" className="block text-foreground/42 tabular-nums">
              {t("sources.stats", {
                buffer: runtimeStatus.bufferSize,
                outbox: runtimeStatus.outboxPendingCount,
                ingested: runtimeStatus.totalIngested,
              })}
              {runtimeStatus.totalIngestErrors > 0
                ? t("sources.statsErrors", { n: runtimeStatus.totalIngestErrors })
                : ""}
            </Text>
            <button
              type="button"
              onClick={() => void flush()}
              disabled={runtimeStatus.bufferSize === 0}
              className="min-h-10 rounded-lg bg-foreground/[0.08] px-3 text-micro font-medium text-foreground/55 transition-colors hover:bg-foreground/[0.12] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t("sources.flush")}
            </button>
          </div>
          <Text variant="micro" className="block mt-1 text-foreground/35">
            {t("sources.lastTimes", {
              ok: formatTime(runtimeStatus.lastSuccessfulDrainTs),
              drain: formatTime(runtimeStatus.lastDrainTs),
            })}
          </Text>
          {runtimeStatus.lastIngestError && (
            <Text variant="caption" className="block mt-1.5 leading-snug text-red-500">
              {t("sources.ingestError", { error: runtimeStatus.lastIngestError })}
            </Text>
          )}
        </div>
      )}

      {error && (
        <Text variant="caption" className="block leading-snug text-red-500">{error}</Text>
      )}
    </section>
  );
}
