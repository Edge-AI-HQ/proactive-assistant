/**
 * connector.init 进度 chip——web `ui-web/connect/DataConnections.tsx` 里
 * `InitTaskChip`（含 getInitTaskResult 等 helper）的 RN 复制版，文案走 i18n
 * （t() key 与 web 相同：dataConnections.initTask.*）。轮询逻辑复用
 * @pin-ai/state 的 useInitTask / isInitTaskFresh（与 web 同一 hook）。
 *
 * 渲染规则（同 web）：
 *   - running:   "Initializing · Fetching data (limit 100)"
 *   - succeeded: "Initialized · 12 fetched"（完成 1h 后静默）
 *   - failed:    "Initialization failed — short error reason"（同窗口）
 *   - 查不到行:  什么都不渲染（静默兜底）
 */
import { StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { buildConnectorInitTaskId, normalizeComposioToolkit } from "@pin-ai/core";
import { isInitTaskFresh, useInitTask } from "@pin-ai/state";

import { Spinner } from "../../ui/Spinner";

const FG = "29,33,48";
const EMERALD_600_80 = "rgba(5,150,105,0.8)";
const RED_500_80 = "rgba(239,68,68,0.8)";

function resultNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getInitTaskResult(
  result: Record<string, unknown> | null,
  taskToolkit: string,
  sourceToolkit: string,
): Record<string, unknown> | null {
  if (!result) return null;
  const taskKey = normalizeComposioToolkit(taskToolkit);
  const sourceKey = normalizeComposioToolkit(sourceToolkit);
  const perToolkit = result.perToolkit;
  if (perToolkit && typeof perToolkit === "object" && !Array.isArray(perToolkit)) {
    const subResult = (perToolkit as Record<string, unknown>)[sourceKey];
    if (subResult && typeof subResult === "object" && !Array.isArray(subResult)) {
      return subResult as Record<string, unknown>;
    }
    return taskKey === sourceKey ? result : null;
  }
  return taskKey === sourceKey ? result : null;
}

export default function InitTaskChip({
  toolkit,
  connectedAccountId,
  sourceToolkit = toolkit,
}: {
  toolkit: string;
  connectedAccountId: string;
  sourceToolkit?: string;
}) {
  const { t } = useTranslation("connect");
  const taskId = buildConnectorInitTaskId(toolkit, connectedAccountId);
  const { task, terminal } = useInitTask(taskId);
  // 首次 /tasks 轮询返回前 task 为 null。此时**不要**乐观渲染 "Initializing…"：
  // 打开 Connect 时 Core sources 里每个已连接 source 都挂一个 chip，它们的真实状态
  // 几乎都是"早已完成/无任务"——乐观 chip 会闪现一瞬再消失，导致整行收起、下方内容
  // 跳动。等第一份结果回来再按真实状态渲染：真正在跑的 init 会走下面 running 分支
  // （tick() 挂载即发首个请求，反馈仍即时）。
  if (!task) return null;
  if (!isInitTaskFresh(task)) return null; // stale terminal — silent
  if (terminal) {
    if (task.status === "succeeded") {
      const taskResult = { ...task.progress, ...(task.result ?? {}) };
      const displayResult = getInitTaskResult(taskResult, toolkit, sourceToolkit);
      const memoriesWritten = resultNumber(displayResult?.memoriesWritten);
      const skillsAdded = resultNumber(displayResult?.skillsAdded);
      const fetched = finiteNumber(displayResult?.fetched) ?? resultNumber(displayResult?.rawInserted);
      const skipped = Boolean(task.result?.skipped);
      if (skipped) {
        // reason 是后端 enum/slug——有意原样渲染。
        const reason = String(task.result?.reason ?? "skipped");
        return (
          <Text style={styles.muted} numberOfLines={1}>
            {t("dataConnections.initTask.skipped", { reason })}
          </Text>
        );
      }
      const memories =
        memoriesWritten > 0
          ? ` · ${t("dataConnections.initTask.memories", { count: memoriesWritten })}`
          : "";
      const skills =
        skillsAdded > 0 ? ` · ${t("dataConnections.initTask.skills", { count: skillsAdded })}` : "";
      return (
        <Text style={styles.success} numberOfLines={1}>
          {`${t("dataConnections.initTask.initialized", { fetched })}${memories}${skills}`}
        </Text>
      );
    }
    // failed / timed_out / cancelled / lost — 最短错误
    const shortErr = (
      task.last_error_message ?? task.last_error_code ?? t("dataConnections.initTask.unknownError")
    ).slice(0, 80);
    return (
      <Text style={styles.failed} numberOfLines={1}>
        {t("dataConnections.initTask.failed", { error: shortErr })}
      </Text>
    );
  }
  // running / queued — stage + 进度
  const stage = typeof task.progress?.stage === "string" ? task.progress.stage : null;
  const limit = Number(task.payload?.limit ?? 0);
  const progressDetail = (() => {
    if (!stage) return t("dataConnections.initTask.stageQueued");
    if (stage === "fetch") {
      return limit
        ? t("dataConnections.initTask.stageFetchWithLimit", { limit })
        : t("dataConnections.initTask.stageFetch");
    }
    if (stage === "raw") return t("dataConnections.initTask.stageRaw");
    if (stage === "signals") return t("dataConnections.initTask.stageSignals");
    if (stage === "evolve") return t("dataConnections.initTask.stageEvolve");
    return stage; // 未知 stage = 后端标识，原样渲染
  })();
  return (
    <View style={styles.row}>
      <Spinner size={9} color={`rgba(${FG},0.45)`} />
      <Text style={styles.running} numberOfLines={1}>
        {t("dataConnections.initTask.initializingDetail", { detail: progressDetail })}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 4 },
  muted: { flexShrink: 1, fontSize: 10, lineHeight: 14, fontFamily: "Inter_400Regular", color: `rgba(${FG},0.4)` },
  running: { flexShrink: 1, fontSize: 10, lineHeight: 14, fontFamily: "Inter_400Regular", color: `rgba(${FG},0.45)` },
  success: { fontSize: 10, lineHeight: 14, fontFamily: "Inter_400Regular", color: EMERALD_600_80 },
  failed: { fontSize: 10, lineHeight: 14, fontFamily: "Inter_400Regular", color: RED_500_80 },
});
