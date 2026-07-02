/**
 * AmbientModelSetupStep —— dev 同名组件的 RN 移植（onboarding 第 3 步）：
 * 推荐 Gemma 2B 一键下载 → 下载完自动 verify + 选为 Ambient summary 模型。
 * dev 走 Capacitor `AmbientAi.models.*`；RN 走 `modules/ambient-models` 的
 * `AmbientModels`（同一批 Swift，方法名 list→listModels / startDownload→
 * startModelDownload，事件同名；addListener 返回同步 EventSubscription）。
 * 选中持久化走 ambient/models-selection（AsyncStorage，Setting 模型卡同源）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { CheckCircle2 } from "lucide-react-native";
import { useTranslation } from "react-i18next";

import {
  AmbientModels,
  type ModelDownloadProgressEvent,
  type ModelDownloadStatus,
  type ModelMirror,
  type ModelProfile,
} from "../../../modules/ambient-models";
import {
  RECOMMENDED_AMBIENT_LLM_LABEL,
  RECOMMENDED_AMBIENT_LLM_MODEL_ID,
} from "../../ambient/models-recommendation";
import { setSelectedAmbientSummaryModelId } from "../../ambient/models-selection";
import i18n from "../../i18n";
import { GlassCard } from "../../ui/GlassCard";
import Spin from "./Spin";

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

const FG = "230, 25%, 15%";
const fg = (a?: number) => (a === undefined ? `hsl(${FG})` : `hsla(${FG}, ${a})`);
const BACKGROUND = "hsl(220, 30%, 96%)";
const EMERALD_600 = "#059669";

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
      const result = await AmbientModels.listModels();
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
      const verify = await AmbientModels.verifyModel({ id: recommended.id });
      if (!verify.ok) {
        setError(verify.errorMessage ?? i18n.t("onboarding:model.verificationFailed"));
        return;
      }
      void setSelectedAmbientSummaryModelId(recommended.id);
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
    // native 未链入的 build 上 AmbientModels 是抛错 Proxy——不让监听器把整步打崩，
    // 报错交给 refresh() 的 error 态展示。
    try {
      const subs = [
        AmbientModels.addListener("modelDownloadProgress", (event: ModelDownloadProgressEvent) => {
          if (!active || event.id !== RECOMMENDED_AMBIENT_LLM_MODEL_ID) return;
          setStatusById((prev) => ({ ...prev, [event.id]: event }));
        }),
        AmbientModels.addListener("modelDownloadDone", (event: ModelDownloadProgressEvent) => {
          if (!active || event.id !== RECOMMENDED_AMBIENT_LLM_MODEL_ID) return;
          setStatusById((prev) => ({ ...prev, [event.id]: event }));
          void verifyAndSelect();
        }),
      ];
      return () => {
        active = false;
        subs.forEach((sub) => sub.remove());
      };
    } catch {
      return () => {
        active = false;
      };
    }
  }, [verifyAndSelect]);

  const handleDownload = useCallback(async () => {
    if (!recommended) return;
    setBusy(true);
    setError(null);
    try {
      await AmbientModels.startModelDownload({
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
    <GlassCard style={{ padding: compact ? 12 : 16 }}>
      <View style={styles.headRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.recommendedBadge}>{t("model.recommendedBadge")}</Text>
          <Text style={styles.modelTitle}>{RECOMMENDED_AMBIENT_LLM_LABEL}</Text>
          <Text style={styles.description}>{t("model.description")}</Text>
        </View>
        {verified ? <CheckCircle2 size={20} color={EMERALD_600} style={{ marginTop: 4 }} /> : null}
      </View>

      <View style={styles.modelBox}>
        <Text style={styles.modelName}>{recommended.displayName}</Text>
        <Text style={styles.modelMeta}>
          {formatBytes(recommended.approxBytes)} · {recommended.repo}
        </Text>
        {recommended.notes ? <Text style={styles.modelNotes}>{recommended.notes}</Text> : null}
        {downloading && status ? (
          <Text style={styles.downloading}>
            {t("model.downloading", {
              percent: formatPercent(status.bytesWritten, status.bytesTotal || recommended.approxBytes),
            })}
          </Text>
        ) : null}
      </View>

      <View style={styles.actionRow}>
        <Pressable
          onPress={present ? verifyAndSelect : handleDownload}
          disabled={busy || downloading}
          accessibilityRole="button"
          style={{ flex: 1 }}
        >
          {({ pressed }) => (
            <View
              style={[
                styles.actionButton,
                (busy || downloading) && { opacity: 0.5 },
                pressed && !(busy || downloading) && { opacity: 0.9 },
              ]}
            >
              {busy ? <Spin size={14} color={`hsla(220, 30%, 96%, 0.8)`} /> : null}
              <Text style={styles.actionButtonText}>
                {present ? t("model.use") : t("model.download")}
              </Text>
            </View>
          )}
        </Pressable>
      </View>
      <Text style={styles.skipNote}>{t("model.skipNote")}</Text>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </GlassCard>
  );
}

const styles = StyleSheet.create({
  headRow: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  // dev: caption(11) semibold uppercase tracking-wider fg/40。
  recommendedBadge: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
    lineHeight: 15,
    letterSpacing: 0.55,
    textTransform: "uppercase",
    color: fg(0.4),
  },
  // dev: text-lg(18) font-semibold mt-1。
  modelTitle: { marginTop: 4, fontFamily: "Inter_600SemiBold", fontSize: 18, lineHeight: 25, color: fg() },
  // dev: label(12) leading-relaxed fg/55 mt-1。
  description: { marginTop: 4, fontFamily: "Inter_400Regular", fontSize: 12, lineHeight: 19, color: fg(0.55) },
  // dev: mt-3 rounded-xl(12) border fg/10 bg-white/50 p-3。
  modelBox: {
    marginTop: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: fg(0.1),
    backgroundColor: "rgba(255,255,255,0.5)",
    padding: 12,
  },
  modelName: { fontFamily: "Inter_500Medium", fontSize: 12, lineHeight: 16, color: fg(0.75) },
  modelMeta: { marginTop: 2, fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: fg(0.45) },
  modelNotes: { marginTop: 4, fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 13, color: fg(0.45) },
  downloading: {
    marginTop: 8,
    fontFamily: "Inter_400Regular",
    fontSize: 10,
    lineHeight: 14,
    color: fg(0.5),
    fontVariant: ["tabular-nums"],
  },
  actionRow: { marginTop: 12, flexDirection: "row", alignItems: "center", gap: 8 },
  // dev: min-h-10(40) rounded-full bg-foreground px-4 bodySm semibold text-background。
  actionButton: {
    minHeight: 40,
    borderRadius: 999,
    backgroundColor: fg(),
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  actionButtonText: { fontFamily: "Inter_600SemiBold", fontSize: 13, lineHeight: 19, color: BACKGROUND },
  skipNote: { marginTop: 8, fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 13, color: fg(0.45) },
  errorText: { marginTop: 8, fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 15, color: "#ef4444" },
});
