/**
 * ConnectorOnboardingInsight —— ui-web 同名组件（684 行）的 RN 全量移植。
 * 逻辑层零重写：useInitTask / isInitTaskFresh / buildConnector*TaskId /
 * proxyPost 全部直用 @pin-ai/state / @pin-ai/core；候选选择、summary 请求
 * 去重缓存、状态机逐字同源。渲染层 <div>→<View>、lucide-react→-native。
 * 文案与 dev 一致为硬编码英文（dev 未 i18n 的保持硬编码——i18n 铁律）。
 *
 * 三模式：watcher（onboarding 步进页隐形探针，只回报状态）/ page（Done 后的
 * 全页 preview）/ inline（内嵌卡，Connect 场景备用）。
 * 卡片介质 = dev `glass-card-strong` + `border-foreground/[0.08]` 覆盖边
 * （bracket 任意值是活类，和 /8 短写死类不同）→ StrongCard 手工复刻。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import {
  BriefcaseBusiness,
  Check,
  CheckCircle2,
  ChevronRight,
  MessageSquareText,
  ShieldCheck,
  Sparkles,
  UsersRound,
  X,
  XCircle,
} from "lucide-react-native";
import type { Connection, InitTaskRow } from "@pin-ai/state";
import {
  buildConnectorInitTaskId,
  buildConnectorPreviewTaskId,
  isInitTaskFresh,
  useInitTask,
} from "@pin-ai/state";
import { proxyPost } from "@pin-ai/core";

import Spin from "./Spin";

export type ConnectorInsightStatus = "hidden" | "pending" | "ready" | "error";

interface ConnectorOnboardingInsightProps {
  connections: Connection[];
  mode?: "inline" | "page" | "watcher";
  onStatusChange?: (status: ConnectorInsightStatus, insightKey: string | null) => void;
  onContinue?: () => void;
  continueLabel?: string;
}

interface ConnectorSummarySection {
  title: string;
  bullets: string[];
}

interface ConnectorSummaryResponse {
  ok: boolean;
  source: {
    toolkit: string;
    connectedAccountId: string | null;
    itemCount: number;
  };
  summary: {
    displayName: string | null;
    headline: string;
    sections: ConnectorSummarySection[];
    note: string | null;
  };
  modelId: string;
}

type SummaryState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: ConnectorSummaryResponse }
  | { status: "error"; message: string };

const summaryRequests = new Map<string, Promise<ConnectorSummaryResponse>>();
const RUNNING_TASK_STATUSES = new Set(["queued", "running"]);

interface InsightCandidate {
  connection: Connection;
  taskId: string;
  kind: "preview" | "init";
}

interface TaskReport {
  candidate: InsightCandidate;
  task: InitTaskRow | null;
  fresh: boolean;
}

const TOOLKIT_LABELS: Record<string, string> = {
  gmail: "Gmail",
  googlecalendar: "Calendar",
  googledrive: "Drive",
  googledocs: "Docs",
  googlesheets: "Sheets",
  googlesuper: "Google Workspace",
  slack: "Slack",
  github: "GitHub",
  calendly: "Calendly",
  stripe: "Stripe",
  youtube: "YouTube",
  linkedin: "LinkedIn",
};

const FG = "230, 25%, 15%";
const fg = (a?: number) => (a === undefined ? `hsl(${FG})` : `hsla(${FG}, ${a})`);
/** token --background: 220 30% 96%（bg-foreground 按钮上的文字色）。 */
const BACKGROUND = "hsl(220, 30%, 96%)";
const EMERALD_600 = "#059669";
const RED_500 = "#ef4444";
const emerald = (a: number) => `rgba(16, 185, 129, ${a})`;

export default function ConnectorOnboardingInsight({
  connections,
  mode = "inline",
  onStatusChange,
  onContinue,
  continueLabel = "Continue setup",
}: ConnectorOnboardingInsightProps) {
  const activeConnections = useMemo(
    () =>
      connections.filter(
        (conn): conn is Connection & { connectedAccountId: string } =>
          conn.status === "ACTIVE" && Boolean(conn.connectedAccountId),
      ),
    [connections],
  );
  const candidates = useMemo(
    () =>
      activeConnections.flatMap((conn) => {
        const connectedAccountId = conn.connectedAccountId;
        return [
          {
            connection: conn,
            taskId: buildConnectorPreviewTaskId(conn.toolkit, connectedAccountId),
            kind: "preview" as const,
          },
          {
            connection: conn,
            taskId: buildConnectorInitTaskId(conn.toolkit, connectedAccountId),
            kind: "init" as const,
          },
        ];
      }),
    [activeConnections],
  );
  const [reports, setReports] = useState<Record<string, TaskReport>>({});
  const handleReport = useCallback((taskId: string, report: TaskReport) => {
    setReports((prev) => ({ ...prev, [taskId]: report }));
  }, []);
  const handleRemove = useCallback((taskId: string) => {
    setReports((prev) => {
      const next = { ...prev };
      delete next[taskId];
      return next;
    });
  }, []);

  useEffect(() => {
    const candidateKeys = new Set(candidates.map((candidate) => candidate.taskId));
    setReports((prev) => {
      const next = Object.fromEntries(
        Object.entries(prev).filter(([key]) => candidateKeys.has(key)),
      );
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
  }, [candidates]);

  const selected = useMemo(() => selectInsightCandidate(candidates, reports), [candidates, reports]);

  useEffect(() => {
    if (candidates.length === 0) {
      onStatusChange?.("hidden", null);
    }
  }, [candidates.length, onStatusChange]);

  return (
    <>
      {candidates.map((conn) => (
        <ConnectorTaskProbe
          key={conn.taskId}
          candidate={conn}
          onReport={handleReport}
          onRemove={handleRemove}
        />
      ))}

      {selected ? (
        <ConnectorInsightCandidate
          key={selected.taskId}
          candidate={selected}
          mode={mode}
          connectedCount={activeConnections.length}
          onStatusChange={onStatusChange}
          onContinue={onContinue}
          continueLabel={continueLabel}
        />
      ) : null}
    </>
  );
}

function ConnectorTaskProbe({
  candidate,
  onReport,
  onRemove,
}: {
  candidate: InsightCandidate;
  onReport: (taskId: string, report: TaskReport) => void;
  onRemove: (taskId: string) => void;
}) {
  const { task } = useInitTask(candidate.taskId);
  const fresh = isInitTaskFresh(task);

  useEffect(() => {
    onReport(candidate.taskId, { candidate, task, fresh });
    return () => onRemove(candidate.taskId);
  }, [candidate, fresh, onRemove, onReport, task]);

  return null;
}

function ConnectorInsightCandidate({
  candidate,
  mode,
  connectedCount,
  onStatusChange,
  onContinue,
  continueLabel,
}: {
  candidate: InsightCandidate;
  mode: "inline" | "page" | "watcher";
  connectedCount: number;
  onStatusChange?: (status: ConnectorInsightStatus, insightKey: string | null) => void;
  onContinue?: () => void;
  continueLabel: string;
}) {
  const { connection } = candidate;
  const connectedAccountId = connection.connectedAccountId;
  const { task } = useInitTask(candidate.taskId);
  const [summaryState, setSummaryState] = useState<SummaryState>({ status: "idle" });
  const [dismissed, setDismissed] = useState(false);
  const requestedKeyRef = useRef<string | null>(null);

  const freshTask = isInitTaskFresh(task);
  const taskKey = `${candidate.taskId}:${task?.completed_at ?? ""}`;
  const label = toolkitLabel(connection.toolkit);

  useEffect(() => {
    if (!connectedAccountId || !task || !freshTask || task.status !== "succeeded") return;
    if (requestedKeyRef.current === taskKey) return;

    requestedKeyRef.current = taskKey;
    setDismissed(false);
    setSummaryState({ status: "loading" });
    onStatusChange?.("pending", taskKey);

    let cancelled = false;
    const run = async () => {
      try {
        const body = await loadConnectorSummary(
          taskKey,
          connection.toolkit,
          connectedAccountId,
          connection.label,
          connection.userInfo,
        );
        if (!cancelled) {
          setSummaryState({ status: "ready", data: body });
          onStatusChange?.("ready", taskKey);
        }
      } catch (err) {
        if (!cancelled) {
          setSummaryState({
            status: "error",
            message: err instanceof Error ? err.message : "Summary failed",
          });
          onStatusChange?.("error", taskKey);
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [connectedAccountId, connection.toolkit, connection.label, connection.userInfo, freshTask, onStatusChange, task, taskKey]);

  useEffect(() => {
    if (!task || !freshTask || task.status === "succeeded") return;
    const status = RUNNING_TASK_STATUSES.has(task.status) ? "pending" : "error";
    onStatusChange?.(status, `${connection.toolkit}:${connectedAccountId}:${task.completed_at ?? task.started_at ?? ""}`);
  }, [connectedAccountId, connection.toolkit, freshTask, onStatusChange, task]);

  if (dismissed || !task || !freshTask) return null;
  if (mode === "watcher" && summaryState.status !== "ready" && summaryState.status !== "error") return null;
  if (mode === "watcher") return null;

  if (task.status === "queued" || task.status === "running") {
    return (
      <InsightShell
        title="Reading your first connector items"
        icon={<Spin size={14} color={EMERALD_600} />}
        mode={mode}
        onDismiss={() => setDismissed(true)}
      >
        <Text style={styles.bodyLabel}>
          {label} is connected. PIN AI is pulling recent data and will summarize it here while you
          keep setting up.
        </Text>
      </InsightShell>
    );
  }

  if (task.status !== "succeeded") {
    return (
      <InsightShell
        title="Connector summary is not ready"
        icon={<XCircle size={14} color={RED_500} />}
        tone="error"
        mode={mode}
        onDismiss={() => setDismissed(true)}
        onContinue={onContinue}
        continueLabel={continueLabel}
      >
        <Text style={styles.bodyLabel}>
          The first {label} pull did not finish cleanly yet. You can continue onboarding and try
          again later.
        </Text>
      </InsightShell>
    );
  }

  if (summaryState.status === "ready") {
    const { data } = summaryState;
    const sourceBadges = [
      `${data.source.itemCount} ${toolkitLabel(data.source.toolkit)} items`,
      ...(connectedCount > 1 ? [`${connectedCount - 1} more connected`] : []),
    ];
    return (
      <InsightShell
        title="Here's what we know about you"
        icon={<Sparkles size={14} color={EMERALD_600} />}
        badges={sourceBadges}
        mode={mode}
        onDismiss={() => setDismissed(true)}
        onContinue={onContinue}
        continueLabel={continueLabel}
      >
        <ConnectorSummaryContent data={data} mode={mode} />
      </InsightShell>
    );
  }

  if (summaryState.status === "error") {
    return (
      <InsightShell
        title="Summary failed"
        icon={<XCircle size={14} color={RED_500} />}
        tone="error"
        mode={mode}
        onDismiss={() => setDismissed(true)}
        onContinue={onContinue}
        continueLabel={continueLabel}
      >
        <Text style={styles.bodyLabel}>{summaryState.message}</Text>
      </InsightShell>
    );
  }

  return (
    <InsightShell
      title="Summarizing what we found"
      icon={<Spin size={14} color={EMERALD_600} />}
      mode={mode}
      onDismiss={() => setDismissed(true)}
    >
      <Text style={styles.bodyLabel}>
        PIN AI is distilling the recent {label} window into a short profile preview.
      </Text>
    </InsightShell>
  );
}

function ConnectorSummaryContent({
  data,
  mode,
}: {
  data: ConnectorSummaryResponse;
  mode: "inline" | "page" | "watcher";
}) {
  if (mode !== "page") {
    return (
      <View style={{ gap: 16 }}>
        <View style={styles.inlineHeadBlock}>
          {data.summary.displayName ? (
            <Text style={styles.summaryDisplayName}>{data.summary.displayName}</Text>
          ) : null}
          <Text style={styles.inlineHeadline}>{data.summary.headline}</Text>
        </View>

        <View style={{ gap: 20 }}>
          {data.summary.sections.map((section) => (
            <View key={section.title} style={{ gap: 8 }}>
              <Text style={styles.inlineSectionTitle}>{section.title}</Text>
              <View style={{ gap: 8 }}>
                {section.bullets.map((bullet) => (
                  <View key={bullet} style={styles.inlineBulletRow}>
                    <View style={styles.inlineBulletDot} />
                    <Text style={styles.inlineBulletText}>{bullet}</Text>
                  </View>
                ))}
              </View>
            </View>
          ))}
        </View>

        {data.summary.note ? (
          <View style={styles.inlineNoteRow}>
            <CheckCircle2 size={12} color={fg(0.42)} style={{ marginTop: 2 }} />
            <Text style={styles.inlineNoteText}>{data.summary.note}</Text>
          </View>
        ) : null}
      </View>
    );
  }

  return (
    <View style={{ gap: 20 }}>
      <View style={styles.pageHeadBlock}>
        {data.summary.displayName ? (
          <Text style={styles.summaryDisplayName}>{data.summary.displayName}</Text>
        ) : null}
        <Text style={styles.pageHeadline}>{data.summary.headline}</Text>
      </View>

      <View style={{ gap: 4 }}>
        {data.summary.sections.map((section, index) => {
          const Icon = summarySectionIcon(section.title);
          const isFirst = index === 0;
          const isLast = index === data.summary.sections.length - 1;
          return (
            <View
              key={section.title}
              style={[
                styles.pageSectionRow,
                isFirst && { paddingTop: 0 },
                isLast && { borderBottomWidth: 0, paddingBottom: 0 },
              ]}
            >
              <View style={styles.pageSectionIconBox}>
                <Icon size={15} strokeWidth={1.8} color={fg(0.5)} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.pageSectionTitle}>{section.title}</Text>
                <View style={{ marginTop: 10, gap: 10 }}>
                  {section.bullets.map((bullet) => (
                    <View key={bullet} style={styles.pageBulletRow}>
                      <View style={styles.pageBulletCheck}>
                        <Check size={10.5} strokeWidth={2.4} color={EMERALD_600} />
                      </View>
                      <Text style={styles.pageBulletText}>{bullet}</Text>
                    </View>
                  ))}
                </View>
              </View>
            </View>
          );
        })}
      </View>

      {data.summary.note ? (
        <View style={styles.pageNoteRow}>
          <ShieldCheck size={14} color={fg(0.45)} style={{ marginTop: 2 }} />
          <Text style={styles.pageNoteText}>{data.summary.note}</Text>
        </View>
      ) : null}
    </View>
  );
}

function summarySectionIcon(title: string) {
  const normalized = title.toLowerCase();
  if (normalized.includes("people") || normalized.includes("contact") || normalized.includes("account")) {
    return UsersRound;
  }
  if (normalized.includes("communicat") || normalized.includes("style")) {
    return MessageSquareText;
  }
  if (normalized.includes("identity") || normalized.includes("professional")) {
    return BriefcaseBusiness;
  }
  return Sparkles;
}

/** dev `glass-card-strong` + `border-foreground/[0.08]` 覆盖边（GlassCard 是
 *  white/45 边，此处 dev 用 utility 覆盖成 fg/8——手工复刻不复用 GlassCard）。
 *  导出给 OnboardingFlow 的 InsightWaitPage 复用（dev 同款卡）。 */
export function StrongCard({ style, children }: { style?: object; children: ReactNode }) {
  return (
    <View style={[styles.strongCard, style]}>
      <View style={styles.strongClip} pointerEvents="none">
        <LinearGradient
          colors={["rgba(255,255,255,0.55)", "rgba(255,255,255,0.25)"]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
      </View>
      {children}
    </View>
  );
}

function InsightShell({
  title,
  icon,
  children,
  badges,
  mode,
  tone = "default",
  onDismiss,
  onContinue,
  continueLabel = "Continue setup",
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
  badges?: string[];
  mode: "inline" | "page" | "watcher";
  tone?: "default" | "error";
  onDismiss: () => void;
  onContinue?: () => void;
  continueLabel?: string;
}) {
  const isPage = mode === "page";
  const iconBoxTone = tone === "error" ? styles.iconBoxError : styles.iconBoxEmerald;

  if (isPage) {
    return (
      <StrongCard style={{ flex: 1 }}>
        <View style={styles.pageHeader}>
          <View style={[styles.pageIconBox, iconBoxTone]}>{icon}</View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.pageEyebrow}>Connector preview</Text>
            <Text style={styles.pageTitle}>{title}</Text>
            {badges && badges.length > 0 ? (
              <View style={styles.pageBadgesRow}>
                {badges.map((badge) => (
                  <Text key={badge} style={styles.pageBadge}>
                    {badge}
                  </Text>
                ))}
              </View>
            ) : null}
          </View>
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={styles.pageScrollContent}
          showsVerticalScrollIndicator={false}
        >
          {children}
        </ScrollView>

        {onContinue ? (
          <View style={styles.pageFooter}>
            <Pressable onPress={onContinue} accessibilityRole="button">
              {({ pressed }) => (
                <View style={[styles.continueButton, pressed && { opacity: 0.9 }]}>
                  <Text style={styles.continueButtonText}>{continueLabel}</Text>
                  <ChevronRight size={15} strokeWidth={2} color={BACKGROUND} />
                </View>
              )}
            </Pressable>
          </View>
        ) : null}
      </StrongCard>
    );
  }

  return (
    <StrongCard style={{ marginBottom: 12 }}>
      <View style={styles.inlineShellRow}>
        <View style={[styles.inlineIconBox, iconBoxTone]}>{icon}</View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.inlineEyebrow}>Connector preview</Text>
          <Text numberOfLines={1} style={styles.inlineTitle}>
            {title}
          </Text>
          {badges && badges.length > 0 ? (
            <View style={styles.inlineBadgesRow}>
              {badges.map((badge) => (
                <Text key={badge} style={styles.inlineBadge}>
                  {badge}
                </Text>
              ))}
            </View>
          ) : null}
          <View style={{ marginTop: 12 }}>{children}</View>
        </View>
        <Pressable onPress={onDismiss} accessibilityRole="button" accessibilityLabel="Dismiss connector summary" hitSlop={6}>
          {({ pressed }) => (
            <View style={[styles.dismissButton, pressed && { backgroundColor: fg(0.06) }]}>
              <X size={14} color={fg(0.3)} />
            </View>
          )}
        </Pressable>
      </View>
    </StrongCard>
  );
}

async function loadConnectorSummary(
  taskKey: string,
  toolkit: string,
  connectedAccountId: string,
  connectorLabel: string | null,
  connectorUserInfo: Record<string, unknown> | null,
): Promise<ConnectorSummaryResponse> {
  const existing = summaryRequests.get(taskKey);
  if (existing) return existing;

  const request = (async () => {
    const res = await proxyPost("/onboarding/connector-summary", {
      toolkit,
      connectedAccountId,
      connectorLabel,
      connectorUserInfo,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = typeof body.detail === "string" ? body.detail : `Summary failed (${res.status})`;
      throw new Error(message);
    }
    if (!body.summary || !Array.isArray(body.summary.sections)) {
      throw new Error("Malformed summary response");
    }
    return body as ConnectorSummaryResponse;
  })();

  summaryRequests.set(taskKey, request);
  request.catch(() => {
    summaryRequests.delete(taskKey);
  });
  return request;
}

function selectInsightCandidate(
  candidates: InsightCandidate[],
  reports: Record<string, TaskReport>,
): InsightCandidate | null {
  if (candidates.length === 0 || Object.keys(reports).length === 0) {
    return null;
  }

  const freshReports = Object.values(reports).filter((report) => report.fresh && report.task);
  if (freshReports.length === 0) {
    return null;
  }

  const previewReports = freshReports.filter((report) => report.candidate.kind === "preview");
  const scopedReports = previewReports.length > 0 ? previewReports : freshReports;

  const succeeded = scopedReports.filter((report) => report.task?.status === "succeeded");
  const active = succeeded.length > 0
    ? succeeded
    : scopedReports.filter((report) => report.task?.status === "queued" || report.task?.status === "running");
  const pool = active.length > 0 ? active : scopedReports;

  return [...pool].sort(compareTaskReportPriority)[0]?.candidate ?? null;
}

function compareTaskReportPriority(a: TaskReport, b: TaskReport): number {
  const aKindScore = a.candidate.kind === "preview" ? 0 : 1;
  const bKindScore = b.candidate.kind === "preview" ? 0 : 1;
  if (aKindScore !== bKindScore) return aKindScore - bKindScore;

  const aToolkitScore = normalizedToolkit(a.candidate.connection.toolkit) === "googlesuper" ? 0 : 1;
  const bToolkitScore = normalizedToolkit(b.candidate.connection.toolkit) === "googlesuper" ? 0 : 1;
  if (aToolkitScore !== bToolkitScore) return aToolkitScore - bToolkitScore;

  const aTime = Date.parse(a.task?.completed_at ?? a.task?.started_at ?? "");
  const bTime = Date.parse(b.task?.completed_at ?? b.task?.started_at ?? "");
  return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
}

function toolkitLabel(toolkit: string): string {
  const key = normalizedToolkit(toolkit);
  return TOOLKIT_LABELS[key] ?? toolkit;
}

function normalizedToolkit(toolkit: string): string {
  return toolkit.trim().toLowerCase().replace(/[-_\s]/g, "");
}

const styles = StyleSheet.create({
  // dev glass-card-strong + border-foreground/[0.08] 覆盖边。
  strongCard: {
    borderRadius: 24, // rounded-3xl
    borderWidth: 1,
    borderColor: fg(0.08),
    boxShadow:
      "inset 0 1px 1px rgba(255,255,255,0.6), 0 4px 16px rgba(0,0,0,0.04), 0 1px 4px rgba(0,0,0,0.02)",
  },
  strongClip: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    borderRadius: 23,
    overflow: "hidden",
  },
  iconBoxEmerald: { backgroundColor: emerald(0.08) },
  iconBoxError: { backgroundColor: "rgba(239,68,68,0.08)" },
  // 通用正文（dev Text label leading-5 fg/55）。
  bodyLabel: { fontFamily: "Inter_400Regular", fontSize: 12, lineHeight: 20, color: fg(0.55) },

  // ── page 模式 ──
  pageHeader: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingHorizontal: 20, paddingTop: 20, paddingBottom: 16 },
  pageIconBox: { marginTop: 2, width: 36, height: 36, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  pageEyebrow: {
    marginBottom: 4,
    fontFamily: "Inter_600SemiBold",
    fontSize: 10,
    lineHeight: 14,
    letterSpacing: 1.6, // tracking-[0.16em]
    textTransform: "uppercase",
    color: fg(0.34),
  },
  pageTitle: {
    maxWidth: 288, // max-w-[18rem]
    fontFamily: "Inter_600SemiBold",
    fontSize: 24, // text-title
    lineHeight: 26, // leading-[1.08]
    letterSpacing: -0.6, // tracking-tight
    color: fg(),
  },
  pageBadgesRow: { marginTop: 12, flexDirection: "row", flexWrap: "wrap", gap: 6 },
  pageBadge: {
    borderRadius: 999,
    backgroundColor: fg(0.055),
    paddingHorizontal: 10,
    paddingVertical: 4,
    fontFamily: "Inter_500Medium",
    fontSize: 11, // caption
    lineHeight: 11, // leading-none
    color: fg(0.5),
    overflow: "hidden",
  },
  pageScrollContent: { paddingHorizontal: 20, paddingBottom: 16 },
  pageFooter: {
    flexDirection: "row",
    justifyContent: "flex-end",
    borderTopWidth: 1,
    borderTopColor: fg(0.06),
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  continueButton: {
    minHeight: 44,
    borderRadius: 999,
    backgroundColor: fg(),
    paddingHorizontal: 20,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  continueButtonText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13, // bodySm
    lineHeight: 19,
    color: BACKGROUND,
  },

  // ── inline 模式 ──
  inlineShellRow: { flexDirection: "row", alignItems: "flex-start", gap: 12, padding: 16 },
  inlineIconBox: { marginTop: 2, width: 28, height: 28, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  inlineEyebrow: {
    marginBottom: 4,
    fontFamily: "Inter_600SemiBold",
    fontSize: 10,
    lineHeight: 14,
    letterSpacing: 1.2, // tracking-[0.12em]
    textTransform: "uppercase",
    color: fg(0.32),
  },
  inlineTitle: { fontFamily: "Inter_600SemiBold", fontSize: 14, lineHeight: 20, color: fg() },
  inlineBadgesRow: { marginTop: 8, flexDirection: "row", flexWrap: "wrap", gap: 6 },
  inlineBadge: {
    borderRadius: 999,
    backgroundColor: fg(0.055),
    paddingHorizontal: 8,
    paddingVertical: 4,
    fontFamily: "Inter_500Medium",
    fontSize: 10, // micro
    lineHeight: 10, // leading-none
    color: fg(0.48),
    overflow: "hidden",
  },
  dismissButton: { padding: 4, borderRadius: 8 },

  // ── summary 内容（inline / 非 page）──
  inlineHeadBlock: { borderBottomWidth: 1, borderBottomColor: fg(0.06), paddingBottom: 16 },
  summaryDisplayName: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 20, // text-heading
    lineHeight: 27, // leading-snug
    color: fg(),
  },
  inlineHeadline: { marginTop: 6, fontFamily: "Inter_400Regular", fontSize: 13, lineHeight: 20, color: fg(0.62) },
  inlineSectionTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 12, // text-label
    lineHeight: 16,
    letterSpacing: 0.72, // tracking-[0.06em]
    textTransform: "uppercase",
    color: fg(0.48),
  },
  inlineBulletRow: { flexDirection: "row", gap: 8 },
  inlineBulletDot: {
    marginTop: 8,
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: emerald(0.6),
  },
  inlineBulletText: { flex: 1, fontFamily: "Inter_400Regular", fontSize: 12, lineHeight: 20, color: fg(0.64) },
  inlineNoteRow: {
    flexDirection: "row",
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: fg(0.06),
    paddingTop: 12,
  },
  inlineNoteText: { flex: 1, fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 16, color: fg(0.42) },

  // ── summary 内容（page）──
  pageHeadBlock: {
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: fg(0.06),
    paddingVertical: 16,
  },
  pageHeadline: { marginTop: 6, maxWidth: 544, fontFamily: "Inter_400Regular", fontSize: 13, lineHeight: 24, color: fg(0.64) },
  pageSectionRow: {
    flexDirection: "row",
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: fg(0.06),
    paddingVertical: 16,
  },
  pageSectionIconBox: {
    width: 32,
    height: 32,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: fg(0.045),
  },
  pageSectionTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 11, // caption
    lineHeight: 15,
    letterSpacing: 1.32, // tracking-[0.12em]
    textTransform: "uppercase",
    color: fg(0.48),
  },
  pageBulletRow: { flexDirection: "row", gap: 10 },
  pageBulletCheck: {
    marginTop: 2,
    width: 16,
    height: 16,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: emerald(0.12),
  },
  pageBulletText: { flex: 1, fontFamily: "Inter_400Regular", fontSize: 13, lineHeight: 20, color: fg(0.68) },
  pageNoteRow: {
    flexDirection: "row",
    gap: 10,
    borderRadius: 16, // rounded-2xl
    backgroundColor: fg(0.035),
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  pageNoteText: { flex: 1, fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 16, color: fg(0.48) },
});
