import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  AmbientAi,
  type ModelDownloadProgressEvent,
  type ModelDownloadStatus,
  type ModelMirror,
  type ModelProfile,
} from "@pin/capacitor-ambient-ai";
import {
  RECOMMENDED_AMBIENT_LLM_LABEL,
  RECOMMENDED_AMBIENT_LLM_MODEL_ID,
} from "@/services/ambient/models-recommendation";
import { setSelectedAmbientSummaryModelId } from "@/services/ambient/models-selection";
import { i18n, Text } from "@pin-ai/ui-web";

interface AmbientModelSetupStepProps {
  compact?: boolean;
}

type StatusById = Record<string, ModelDownloadStatus>;

const DEFAULT_MIRROR: ModelMirror = "hf-mirror";
const FALLBACK_GEMMA_PROFILE: ModelProfile = {
  id: RECOMMENDED_AMBIENT_LLM_MODEL_ID,
  kind: "llm",
  displayName: "Gemma 2 2B IT (Q4_K_M)",
  repo: "unsloth/gemma-2-it-GGUF",
  file: "gemma-2-2b-it.q4_k_m.gguf",
  approxBytes: 1_700_000_000,
  magic: "GGUF",
  notes: "Recommended for Ambient summaries.",
};

function formatBytes(value: number): string {
  if (!value || value <= 0) return "—";
  if (value < 1024 * 1024 * 1024) return `${Math.round(value / (1024 * 1024))} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatPercent(written: number, total: number): string {
  if (!total) return "0%";
  return `${Math.min(100, Math.round((written / total) * 100))}%`;
}

export default function AmbientModelSetupStep({ compact = false }: AmbientModelSetupStepProps) {
  const { t } = useTranslation("onboarding");
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [statusById, setStatusById] = useState<StatusById>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await AmbientAi.models.list();
      const recommendedFirst = [
        ...result.profiles.filter((profile) => profile.id === RECOMMENDED_AMBIENT_LLM_MODEL_ID),
        ...result.profiles.filter((profile) => profile.id !== RECOMMENDED_AMBIENT_LLM_MODEL_ID),
      ];
      setProfiles(recommendedFirst);
      setStatusById(Object.fromEntries(result.statuses.map((status) => [status.id, status])));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const recommended = useMemo(
    () => profiles.find((profile) => profile.id === RECOMMENDED_AMBIENT_LLM_MODEL_ID) ?? FALLBACK_GEMMA_PROFILE,
    [profiles],
  );
  const status = recommended ? statusById[recommended.id] : undefined;
  const present = status?.state === "present" || status?.state === "verifying";
  const downloading = status?.state === "downloading" || status?.state === "paused";
  const verified = status?.lastVerifyResult === "ok";

  const verifyAndSelect = useCallback(async () => {
    if (!recommended) return;
    setBusy(true);
    setError(null);
    try {
      const verify = await AmbientAi.models.verifyModel({ id: recommended.id });
      if (!verify.ok) {
        setError(verify.errorMessage ?? i18n.t("onboarding:model.verificationFailed"));
        return;
      }
      setSelectedAmbientSummaryModelId(recommended.id);
      setStatusById((prev) => ({
        ...prev,
        [recommended.id]: {
          ...(prev[recommended.id] ?? {
            id: recommended.id,
            state: "present",
            bytesWritten: recommended.approxBytes,
            bytesTotal: recommended.approxBytes,
          }),
          state: "present",
          lastVerifiedAt: Date.now(),
          lastVerifyResult: "ok",
          lastVerifyOutput: verify.output,
          lastVerifyError: undefined,
        },
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [recommended]);

  useEffect(() => {
    let active = true;
    const progress = AmbientAi.addListener("modelDownloadProgress", (event: ModelDownloadProgressEvent) => {
      if (!active || event.id !== RECOMMENDED_AMBIENT_LLM_MODEL_ID) return;
      setStatusById((prev) => ({ ...prev, [event.id]: event }));
    });
    const done = AmbientAi.addListener("modelDownloadDone", (event: ModelDownloadProgressEvent) => {
      if (!active || event.id !== RECOMMENDED_AMBIENT_LLM_MODEL_ID) return;
      setStatusById((prev) => ({ ...prev, [event.id]: event }));
      void verifyAndSelect();
    });
    return () => {
      active = false;
      void progress.then((handle) => handle.remove());
      void done.then((handle) => handle.remove());
    };
  }, [verifyAndSelect]);

  const handleDownload = useCallback(async () => {
    if (!recommended) return;
    setBusy(true);
    setError(null);
    try {
      await AmbientAi.models.startDownload({
        id: recommended.id,
        preferredMirror: DEFAULT_MIRROR,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [recommended]);

  return (
    <section className={`glass-card-strong ${compact ? "p-3" : "p-4"}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <Text variant="caption" weight="semibold" className="block uppercase tracking-wider text-foreground/40">{t("model.recommendedBadge")}</Text>
          <h2 className="mt-1 text-lg font-semibold text-foreground">{RECOMMENDED_AMBIENT_LLM_LABEL}</h2>
          <Text variant="label" className="block mt-1 leading-relaxed text-foreground/55">
            {t("model.description")}
          </Text>
        </div>
        {verified ? <CheckCircle2 size={20} className="mt-1 text-emerald-600" /> : null}
      </div>

      <div className="mt-3 rounded-xl border border-foreground/10 bg-white/50 p-3">
        <Text variant="label" weight="medium" className="block text-foreground/75">{recommended.displayName}</Text>
        <Text variant="micro" className="block mt-0.5 text-foreground/45">
          {formatBytes(recommended.approxBytes)} · {recommended.repo}
        </Text>
        {recommended.notes ? (
          <Text variant="micro" className="block mt-1 leading-snug text-foreground/45">{recommended.notes}</Text>
        ) : null}
        {downloading && status ? (
          <Text variant="micro" className="block mt-2 tabular-nums text-foreground/50">
            {t("model.downloading", { percent: formatPercent(status.bytesWritten, status.bytesTotal || recommended.approxBytes) })}
          </Text>
        ) : null}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={present ? verifyAndSelect : handleDownload}
          disabled={busy || downloading}
          className="inline-flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-full bg-foreground px-4 text-bodySm font-semibold text-background transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : null}
          {present ? t("model.use") : t("model.download")}
        </button>
      </div>
      <Text variant="micro" className="block mt-2 leading-snug text-foreground/45">
        {t("model.skipNote")}
      </Text>
      {error ? <Text variant="caption" className="block mt-2 text-red-500">{error}</Text> : null}
    </section>
  );
}
