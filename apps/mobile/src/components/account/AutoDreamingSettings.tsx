/**
 * Auto Dreaming 设置 —— web `ui-web/account/AutoDreamingSettings.tsx`（843 行）的
 * RN 全量对应物（Preferences 子页 Dreaming section）。三视图：
 * - home：开关 + 最近一次 run + Run Dreaming / View History；
 * - history：按天分组的 run 列表（展开/收起、每天默认 3 条可展开全部、加载更早）；
 * - detail：run 状态 / dream journal / collected context / source status /
 *   candidate cards / logs / profile & goal diff / goal changes / raw payloads /
 *   两条 apply 状态徽章，running 时 1.5s 轮询。
 * 数据走 core proxyFetch/proxyPost（/dreaming/runs 系，零重写）；文案走 i18n
 * （account:evolution.*，与 dev 同 key）。web `<details>` → Pressable 折叠（WebKit
 * 默认三角盘 → ChevronRight 旋转）；`<pre>` → Menlo Text（长行 RN 自动换行，
 * web 是横向滚动——手机上换行更可读）。
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react-native";
import { proxyFetch, proxyPost } from "@pin-ai/core";
import { useUserSettings } from "@pin-ai/state";

import i18n from "../../i18n";
import { GlassCard } from "../../ui/GlassCard";
import { formatDateTime, formatTime } from "../../lib/format";
import { SettingsSwitch } from "./SettingsSwitch";

const FG = "230, 25%, 15%";
const fg = (a?: number) => (a === undefined ? `hsl(${FG})` : `hsla(${FG}, ${a})`);
const PRIMARY = "hsl(292, 78%, 63%)";
const BG = "hsl(220, 30%, 96%)";
const EMERALD_600 = "#059669";
const RED_600 = "#dc2626";
const AMBER_700 = "#b45309";

// Auto-dreaming runs daily at 06:00 in the user's profile timezone. The
// cadence is fixed in the backend scheduler for now, so the UI only
// mirrors the user-facing label.
interface AutoDreamingSchedule {
  type: "daily";
  hour: number;
  minute: number;
  timezone: string;
}

const DREAMING_SCHEDULE: AutoDreamingSchedule = {
  type: "daily", hour: 6, minute: 0, timezone: "local",
};

// The backend returns snake_case keys (mirrors the dream_runs row shape).
interface AutoDreamingRun {
  id: string;
  trigger?: string;
  status: string;
  started_at?: string;
  completed_at?: string | null;
  applied_at?: string | null;
  goals_applied_at?: string | null;
  superseded?: boolean;
  summary?: { text?: string } | null;
  source_stats?: Record<string, { status?: string; count?: number; message?: string }> | null;
}

interface DreamSourceBreakdown {
  sourceId: string;
  status: "ok" | "skipped" | "error";
  itemCount: number;
  reason?: string;
  connectors?: Array<{
    connectorId: string;
    status: "ok" | "skipped" | "error";
    itemCount: number;
    reason?: string;
  }>;
}

interface DreamRunDetailResponse {
  ok: boolean;
  run: AutoDreamingRun;
  detail: {
    rawInputs: Record<string, unknown>;
    normalizedInputs: Record<string, unknown>;
    summary: { kind: string; text: string };
    dreamMarkdownPath: string | null;
    dreamMarkdown: string;
    profileDelta: Record<string, unknown>;
    goalDelta: { changes?: Array<Record<string, unknown>> };
    candidates: Array<Record<string, unknown>>;
    sourceBreakdown: DreamSourceBreakdown[];
    logPath: string | null;
    logText: string;
  };
}

type ViewMode = "home" | "history" | "detail";
const DEFAULT_VISIBLE_ITEMS = 5;
const DEFAULT_VISIBLE_HISTORY_DAYS = 7;
const DEFAULT_VISIBLE_RUNS_PER_DAY = 3;

function scheduleLabel(schedule: AutoDreamingSchedule | null): string {
  const at = new Date();
  at.setHours(schedule?.hour ?? 6, schedule?.minute ?? 0, 0, 0);
  return i18n.t("account:evolution.runsDaily", { time: formatTime(at) });
}

function formatStatusLabel(status: string): string {
  if (!status) return "unknown";
  return status.replace(/_/g, " ");
}

function statusTone(status: string): { color: string; bg: string } {
  if (status === "ok" || status === "completed") return { color: EMERALD_600, bg: "rgba(16,185,129,0.1)" };
  if (status === "error" || status === "failed") return { color: RED_600, bg: "rgba(239,68,68,0.1)" };
  return { color: AMBER_700, bg: "rgba(245,158,11,0.1)" };
}

function formatTimestamp(value?: string | null): string {
  if (!value) return "n/a";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatDateTime(date);
}

function formatDreamRunTitle(run: AutoDreamingRun): string {
  if (!run.started_at) return run.id;
  const date = new Date(run.started_at);
  if (Number.isNaN(date.getTime())) return run.id;
  const day = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
  return `${day} · ${run.trigger ?? "manual"}`;
}

function runDayKey(run: AutoDreamingRun): string {
  if (!run.started_at) return "Unknown";
  const date = new Date(run.started_at);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function historyGroups(runs: AutoDreamingRun[]): Array<{ day: string; runs: AutoDreamingRun[] }> {
  const grouped = new Map<string, AutoDreamingRun[]>();
  for (const run of runs) {
    const day = runDayKey(run);
    const current = grouped.get(day) ?? [];
    current.push(run);
    grouped.set(day, current);
  }
  return Array.from(grouped.entries())
    .sort(([left], [right]) => right.localeCompare(left))
    .map(([day, dayRuns]) => ({ day, runs: dayRuns }));
}

function todayDayKey(): string {
  const date = new Date();
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function previousDayKey(day: string): string {
  const date = new Date(`${day}T00:00:00`);
  date.setDate(date.getDate() - 1);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function formatItemMeta(item: Record<string, unknown>): string[] {
  const values = [item.timestamp, item.sender, item.calendar, item.start, item.location];
  return values
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .slice(0, 4);
}

function itemSummaryText(item: Record<string, unknown>): string {
  for (const candidate of [item.preview, item.reason, item.context, item.body, item.description]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate;
  }
  return i18n.t("account:evolution.noSummaryAvailable");
}

function goalChangeTitle(change: Record<string, unknown>, index: number): string {
  const after = change.after && typeof change.after === "object" && !Array.isArray(change.after)
    ? change.after as Record<string, unknown>
    : null;
  const before = change.before && typeof change.before === "object" && !Array.isArray(change.before)
    ? change.before as Record<string, unknown>
    : null;
  return String(after?.title ?? before?.title ?? change.key ?? i18n.t("account:evolution.goalFallback", { index: index + 1 }));
}

function normalizedSourceGroups(normalizedInputs: Record<string, unknown>): Array<{
  sourceId: string;
  items: Array<{ key: string; title: string; summary: string; meta: string[]; connector?: string }>;
}> {
  return Object.entries(normalizedInputs).flatMap(([sourceId, value]) => {
    if (!Array.isArray(value)) return [];
    const items = value
      .filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item))
      .map((item, index) => {
        const title =
          (typeof item.title === "string" && item.title.trim().length > 0 ? item.title : null)
          ?? (typeof item.subject === "string" && item.subject.trim().length > 0 ? item.subject : null)
          ?? i18n.t("account:evolution.itemFallback", { source: sourceId, index: index + 1 });
        return {
          key: `${sourceId}-${typeof item.connector === "string" ? item.connector : "item"}-${index}`,
          title,
          summary: itemSummaryText(item),
          meta: formatItemMeta(item),
          connector: typeof item.connector === "string" ? item.connector : undefined,
        };
      });
    return [{ sourceId, items }];
  });
}

function rawConnectorGroups(rawInputs: Record<string, unknown>): Array<{
  sourceId: string;
  connectors: Array<{ connectorId: string; itemCount: number; raw: unknown }>;
}> {
  return Object.entries(rawInputs).flatMap(([sourceId, raw]) => {
    if (sourceId !== "personal" || !raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const connectors = (raw as { connectors?: Record<string, unknown> }).connectors;
    if (!connectors || typeof connectors !== "object") return [];
    return [{
      sourceId,
      connectors: Object.entries(connectors).map(([connectorId, connectorRaw]) => ({
        connectorId,
        itemCount: inferRawConnectorItemCount(connectorRaw),
        raw: connectorRaw,
      })),
    }];
  });
}

function inferRawConnectorItemCount(connectorRaw: unknown): number {
  if (!connectorRaw || typeof connectorRaw !== "object" || Array.isArray(connectorRaw)) return 0;
  const record = connectorRaw as Record<string, unknown>;
  if (typeof record.itemCount === "number" && Number.isFinite(record.itemCount)) return record.itemCount;

  const toolRuns = Array.isArray(record.toolRuns)
    ? record.toolRuns.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item))
    : [];
  const toolRunCount = toolRuns.reduce((sum, toolRun) => {
    const itemCount = toolRun.itemCount;
    return sum + (typeof itemCount === "number" && Number.isFinite(itemCount) ? itemCount : 0);
  }, 0);
  if (toolRunCount > 0) return toolRunCount;

  const payload = record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
    ? record.payload as Record<string, unknown>
    : null;
  if (Array.isArray(record.messages)) return record.messages.length;
  if (Array.isArray(record.summary_view)) return record.summary_view.length;
  if (Array.isArray(record.items)) return record.items.length;
  if (payload) {
    if (Array.isArray(payload.messages)) return payload.messages.length;
    if (Array.isArray(payload.summary_view)) return payload.summary_view.length;
    if (Array.isArray(payload.items)) return payload.items.length;
    if (Array.isArray(payload.event_data)) return payload.event_data.length;
    if (Array.isArray(payload.files)) return payload.files.length;
  }
  return 0;
}

/** 状态小胶囊（rounded-full px-2 py-0.5 micro/500）。 */
function StatusChip({ status, label }: { status: string; label?: string }) {
  const tone = statusTone(status);
  return (
    <View style={{ borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, backgroundColor: tone.bg }}>
      <Text style={{ fontFamily: "Inter_500Medium", fontSize: 10, lineHeight: 14, color: tone.color }}>
        {label ?? formatStatusLabel(status)}
      </Text>
    </View>
  );
}

/** web `<pre>` —— Menlo 等宽，保留换行（RN Text 长行自动换行）。 */
function Pre({ text, size = 10, color = fg(0.7) }: { text: string; size?: number; color?: string }) {
  return (
    <Text style={{ fontFamily: "Menlo", fontSize: size, lineHeight: Math.round(size * 1.6), color }}>
      {text}
    </Text>
  );
}

/** web `<details>` —— Pressable 折叠，WebKit 默认盘状三角 → ChevronRight 旋转。 */
function Details({ summary, children }: { summary: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ borderRadius: 16, backgroundColor: fg(0.04), paddingHorizontal: 12, paddingVertical: 12 }}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen((o) => !o)}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}>
            <ChevronRight size={12} strokeWidth={2.25} color={fg()} />
          </View>
          <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 12, lineHeight: 16, color: fg() }}>
            {summary}
          </Text>
        </View>
      </Pressable>
      {open ? children : null}
    </View>
  );
}

/** 详情区块标题（web h3 text-xs font-semibold）。 */
function SectionH3({ children }: { children: string }) {
  return (
    <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 12, lineHeight: 16, color: fg() }}>
      {children}
    </Text>
  );
}

export default function AutoDreamingSettings() {
  const { t } = useTranslation("account");
  const { settings, loading: settingsLoading, saving, error: settingsError, patch } = useUserSettings();
  const [runsLoading, setRunsLoading] = useState(true);
  const [startingRun, setStartingRun] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [view, setView] = useState<ViewMode>("home");
  const [runs, setRuns] = useState<AutoDreamingRun[]>([]);
  const [detail, setDetail] = useState<DreamRunDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [visibleHistoryDays, setVisibleHistoryDays] = useState(DEFAULT_VISIBLE_HISTORY_DAYS);

  // Default ON, matching the pai_user_settings.auto_dreaming column DEFAULT
  // (migration 086). Server lazy-creates the row at TRUE; this is only the
  // pre-load display fallback.
  const enabled = settings?.autoDreaming ?? true;
  const schedule = DREAMING_SCHEDULE;
  const loading = settingsLoading || runsLoading;

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const runsRes = await proxyFetch("/dreaming/runs");
        const runsData = await runsRes.json() as { ok: boolean; runs: AutoDreamingRun[] };
        if (!mounted) return;
        setRuns(runsData.runs ?? []);
      } catch {
        if (!mounted) return;
        setError(i18n.t("account:evolution.loadRunsFailed"));
      } finally {
        if (mounted) setRunsLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (settingsError) setError(settingsError);
  }, [settingsError]);

  useEffect(() => {
    if (view !== "detail" || detail?.run.status !== "running") return;
    const timer = setTimeout(() => {
      void loadDetail(detail.run.id, { background: true });
    }, 1500);
    return () => clearTimeout(timer);
    // 依赖刻意不挂 loadDetail（稳定引用），轮询只跟 run id/status/视图变化走。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.run.id, detail?.run.status, view]);

  const latestRun = useMemo(() => runs[0] ?? null, [runs]);
  const groupedRuns = useMemo(() => historyGroups(runs), [runs]);
  const normalizedGroups = useMemo(
    () => detail ? normalizedSourceGroups(detail.detail.normalizedInputs) : [],
    [detail],
  );
  const connectorGroups = useMemo(
    () => detail ? rawConnectorGroups(detail.detail.rawInputs) : [],
    [detail],
  );

  const toggleGroup = (key: string) => {
    setExpandedGroups((current) => ({ ...current, [key]: !current[key] }));
  };

  const isHistoryDayExpanded = (day: string): boolean => {
    const key = `history:${day}`;
    if (key in expandedGroups) return Boolean(expandedGroups[key]);
    const today = todayDayKey();
    return day === today || day === previousDayKey(today);
  };

  const isHistoryDayShowingAll = (day: string): boolean => Boolean(expandedGroups[`history-all:${day}`]);

  const handleToggle = async () => {
    const next = !enabled;
    setError(null);
    setNotice(null);
    const result = await patch({ autoDreaming: next });
    if (result) {
      setNotice(next ? t("evolution.enabledNotice") : t("evolution.disabledNotice"));
    } else {
      setError(settingsError ?? t("evolution.saveFailed"));
    }
  };

  const loadHistory = async (background = false) => {
    if (!background) {
      setError(null);
      setNotice(null);
    }
    try {
      const res = await proxyFetch("/dreaming/runs");
      const data = await res.json() as { ok: boolean; runs: AutoDreamingRun[] };
      setRuns(data.runs ?? []);
      if (!background) setVisibleHistoryDays(DEFAULT_VISIBLE_HISTORY_DAYS);
      if (!background) setView("history");
    } catch {
      if (!background) setError(t("evolution.loadHistoryFailed"));
    }
  };

  const loadDetail = async (runId: string, options?: { background?: boolean }) => {
    if (!options?.background) {
      setError(null);
      setNotice(null);
      setDetailLoading(true);
    }
    try {
      const res = await proxyFetch(`/dreaming/runs/${runId}`);
      // 404 = dispatcher hasn't materialized the run row yet (manual
      // trigger races scheduler tick). Don't blow away an existing
      // `detail` with the error body — the caller is polling, the
      // next tick will succeed.
      if (!res.ok) {
        if (!options?.background) {
          setError(res.status === 404 ? t("evolution.runNotStarted") : t("evolution.loadDetailFailed"));
        }
        return;
      }
      const data = await res.json() as DreamRunDetailResponse;
      setDetail(data);
      if (!options?.background) setExpandedGroups({});
      if (!options?.background) setView("detail");
    } catch {
      if (!options?.background) setError(t("evolution.loadDetailFailed"));
    } finally {
      if (!options?.background) setDetailLoading(false);
    }
  };

  const handleRunDreaming = async () => {
    setStartingRun(true);
    setError(null);
    setNotice(null);
    try {
      const res = await proxyPost("/dreaming/run", {});
      const data = await res.json() as { ok?: boolean; runId?: string; taskId?: string; status?: string; error?: string };
      if (!res.ok) {
        setError(data.error ?? t("evolution.startFailed"));
        return;
      }
      const runRef = data.runId ?? data.taskId;
      setNotice(runRef ? t("evolution.startedWithRef", { ref: runRef }) : t("evolution.started"));
      // Don't loadDetail — the dispatcher hasn't created the run row
      // yet; loadHistory's background poll will surface it once the
      // scheduler tick claims the task.
      await loadHistory(true);
    } catch {
      setError(t("evolution.startFailed"));
    } finally {
      setStartingRun(false);
    }
  };

  // ── History view ──
  if (view === "history") {
    return (
      <GlassCard strong className="p-4" style={{ gap: 12 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 14, lineHeight: 20, color: fg() }}>
            {t("evolution.historyTitle")}
          </Text>
          <Pressable onPress={() => setView("home")} hitSlop={8}>
            <Text style={{ fontFamily: "Inter_400Regular", fontSize: 12, lineHeight: 16, color: fg(0.6) }}>{t("back")}</Text>
          </Pressable>
        </View>
        <View style={{ gap: 8 }}>
          {groupedRuns.slice(0, visibleHistoryDays).map((group) => {
            const expanded = isHistoryDayExpanded(group.day);
            const showingAll = isHistoryDayShowingAll(group.day);
            const visibleRuns = showingAll ? group.runs : group.runs.slice(0, DEFAULT_VISIBLE_RUNS_PER_DAY);
            const scrollable = group.runs.length > DEFAULT_VISIBLE_RUNS_PER_DAY;
            const runsList = (
              <View style={{ gap: 8 }}>
                {visibleRuns.map((run) => {
                  const activeSourceCount = Object.values(run.source_stats ?? {}).filter((item) => Number(item?.count ?? 0) > 0).length;
                  return (
                    <Pressable key={run.id} onPress={() => void loadDetail(run.id)}>
                      <View style={{ borderRadius: 16, backgroundColor: fg(0.04), paddingHorizontal: 12, paddingVertical: 12, gap: 4 }}>
                        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                          <Text style={{ fontFamily: "Inter_500Medium", fontSize: 12, lineHeight: 16, color: fg() }}>
                            {formatDreamRunTitle(run)}
                          </Text>
                          <StatusChip status={run.status} />
                        </View>
                        <Text style={{ fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: fg(0.35) }}>
                          {run.id}
                        </Text>
                        <Text style={{ fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 15, color: fg(0.55) }}>
                          {run.summary?.text ?? t("evolution.noSummaryYet")}
                        </Text>
                        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                          {[
                            run.trigger ?? "manual",
                            formatTimestamp(run.started_at),
                            t("evolution.activeSourceCount", { count: activeSourceCount }),
                            run.applied_at ? t("evolution.applied") : run.superseded ? t("evolution.superseded") : t("evolution.notApplied"),
                          ].map((meta, i) => (
                            <Text key={i} style={{ fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: fg(0.45) }}>
                              {meta}
                            </Text>
                          ))}
                        </View>
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            );
            return (
              <View key={group.day} style={{ borderRadius: 16, backgroundColor: fg(0.04), paddingHorizontal: 12, paddingVertical: 12, gap: 8 }}>
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <View>
                    <Text style={{ fontFamily: "Inter_500Medium", fontSize: 12, lineHeight: 16, color: fg() }}>
                      {group.day === "Unknown" ? t("evolution.unknownDay") : group.day}
                    </Text>
                    <Text style={{ fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: fg(0.45) }}>
                      {t("evolution.runCount", { count: group.runs.length })}
                    </Text>
                  </View>
                  <Pressable onPress={() => toggleGroup(`history:${group.day}`)} hitSlop={8}>
                    <Text style={{ fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: fg(0.55) }}>
                      {expanded ? t("evolution.collapse") : t("evolution.expand")}
                    </Text>
                  </Pressable>
                </View>
                {expanded ? (
                  <View style={{ gap: 8 }}>
                    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <Text style={{ fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: fg(0.45) }}>
                        {scrollable && !showingAll
                          ? t("evolution.showingLatest", { visible: DEFAULT_VISIBLE_RUNS_PER_DAY, total: group.runs.length })
                          : t("evolution.runCount", { count: group.runs.length })}
                      </Text>
                      {scrollable ? (
                        <Pressable onPress={() => toggleGroup(`history-all:${group.day}`)} hitSlop={8}>
                          <Text style={{ fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: fg(0.55) }}>
                            {showingAll ? t("evolution.showLatestOnly") : t("evolution.showAllRuns")}
                          </Text>
                        </Pressable>
                      ) : null}
                    </View>
                    {scrollable ? (
                      <ScrollView style={{ maxHeight: 288 }} contentContainerStyle={{ paddingRight: 4 }} nestedScrollEnabled>
                        {runsList}
                      </ScrollView>
                    ) : (
                      runsList
                    )}
                  </View>
                ) : null}
              </View>
            );
          })}
          {groupedRuns.length > visibleHistoryDays ? (
            <Pressable onPress={() => setVisibleHistoryDays((current) => current + DEFAULT_VISIBLE_HISTORY_DAYS)}>
              <View style={{ borderRadius: 16, backgroundColor: fg(0.06), paddingHorizontal: 12, paddingVertical: 8, alignItems: "center" }}>
                <Text style={{ fontFamily: "Inter_500Medium", fontSize: 12, lineHeight: 16, color: fg() }}>
                  {t("evolution.loadOlderDays")}
                </Text>
              </View>
            </Pressable>
          ) : null}
          {runs.length === 0 ? (
            <Text style={{ fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 15, color: fg(0.45) }}>
              {t("evolution.noRunsYet")}
            </Text>
          ) : null}
        </View>
      </GlassCard>
    );
  }

  // ── Detail view ──
  if (view === "detail" && detail) {
    const goalChanges = detail.detail.goalDelta?.changes ?? [];
    return (
      <GlassCard strong className="p-4" style={{ gap: 12 }}>
        <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 14, lineHeight: 20, color: fg() }}>
              {t("evolution.detailTitle")}
            </Text>
            <Text style={{ marginTop: 4, fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 15, color: fg(0.45) }}>
              {formatDreamRunTitle(detail.run)}
            </Text>
            <Text style={{ marginTop: 4, fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: fg(0.3) }}>
              {detail.run.id}
            </Text>
          </View>
          <Pressable onPress={() => setView("history")} hitSlop={8}>
            <Text style={{ fontFamily: "Inter_400Regular", fontSize: 12, lineHeight: 16, color: fg(0.6) }}>{t("back")}</Text>
          </Pressable>
        </View>

        <View style={{ borderRadius: 16, backgroundColor: fg(0.04), paddingHorizontal: 12, paddingVertical: 12, gap: 8 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <Text style={{ fontFamily: "Inter_500Medium", fontSize: 12, lineHeight: 16, color: fg() }}>{t("evolution.runStatus")}</Text>
            <StatusChip status={detail.run.status} />
          </View>
          <Text style={{ fontFamily: "Inter_400Regular", fontSize: 12, lineHeight: 16, color: fg(0.7) }}>
            {detail.detail.summary.text}
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {[
              t("evolution.startedAt", { time: formatTimestamp(detail.run.started_at) }),
              t("evolution.completedAt", { time: formatTimestamp(detail.run.completed_at) }),
              detail.run.applied_at ? t("evolution.profileApplied") : t("evolution.profilePending"),
            ].map((meta, i) => (
              <Text key={i} style={{ fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: fg(0.45) }}>
                {meta}
              </Text>
            ))}
          </View>
        </View>

        <View style={{ gap: 8 }}>
          <SectionH3>{t("evolution.journalTitle")}</SectionH3>
          <View style={{ borderRadius: 16, backgroundColor: fg(0.04), paddingHorizontal: 12, paddingVertical: 12, gap: 8 }}>
            {detail.detail.dreamMarkdownPath ? (
              <Text style={{ fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: fg(0.45) }}>
                {detail.detail.dreamMarkdownPath}
              </Text>
            ) : null}
            <Pre text={detail.detail.dreamMarkdown || t("evolution.noJournalYet")} size={11} color={fg(0.75)} />
          </View>
        </View>

        <View style={{ gap: 8 }}>
          <SectionH3>{t("evolution.collectedContext")}</SectionH3>
          {normalizedGroups.length > 0 ? (
            normalizedGroups.map((group) => {
              const expanded = Boolean(expandedGroups[`normalized:${group.sourceId}`]);
              const visibleItems = expanded ? group.items : group.items.slice(0, DEFAULT_VISIBLE_ITEMS);
              return (
                <View key={`normalized-${group.sourceId}`} style={{ borderRadius: 16, backgroundColor: fg(0.04), paddingHorizontal: 12, paddingVertical: 12, gap: 8 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <Text style={{ flex: 1, fontFamily: "Inter_500Medium", fontSize: 12, lineHeight: 16, color: fg() }}>
                      {t("evolution.sourceItems", { source: group.sourceId, count: group.items.length })}
                    </Text>
                    {group.items.length > DEFAULT_VISIBLE_ITEMS ? (
                      <Pressable onPress={() => toggleGroup(`normalized:${group.sourceId}`)} hitSlop={8}>
                        <Text style={{ fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: fg(0.55) }}>
                          {expanded ? t("evolution.showLess") : t("evolution.showAll", { count: group.items.length })}
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                  <View style={{ gap: 8 }}>
                    {visibleItems.map((item) => (
                      <View key={item.key} style={{ borderRadius: 16, backgroundColor: fg(0.04), paddingHorizontal: 12, paddingVertical: 8 }}>
                        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                          <Text style={{ fontFamily: "Inter_500Medium", fontSize: 11, lineHeight: 15, color: fg() }}>
                            {item.title}
                          </Text>
                          {item.connector ? (
                            <View style={{ borderRadius: 999, backgroundColor: fg(0.06), paddingHorizontal: 8, paddingVertical: 2 }}>
                              <Text style={{ fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: fg(0.55) }}>
                                {item.connector}
                              </Text>
                            </View>
                          ) : null}
                        </View>
                        {item.meta.length > 0 ? (
                          <View style={{ marginTop: 4, flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                            {item.meta.map((metaValue, index) => (
                              <Text key={`${item.key}-meta-${index}`} style={{ fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: fg(0.4) }}>
                                {metaValue}
                              </Text>
                            ))}
                          </View>
                        ) : null}
                        <Text style={{ marginTop: 4, fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 20, color: fg(0.6) }}>
                          {item.summary}
                        </Text>
                      </View>
                    ))}
                  </View>
                </View>
              );
            })
          ) : (
            <Text style={{ fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 15, color: fg(0.45) }}>
              {t("evolution.noNormalizedItems")}
            </Text>
          )}
        </View>

        <View style={{ gap: 8 }}>
          <SectionH3>{t("evolution.sourceStatus")}</SectionH3>
          <View style={{ gap: 8 }}>
            {detail.detail.sourceBreakdown.map((source) => (
              <View key={source.sourceId} style={{ borderRadius: 16, backgroundColor: fg(0.04), paddingHorizontal: 12, paddingVertical: 12, gap: 8 }}>
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <Text style={{ fontFamily: "Inter_500Medium", fontSize: 12, lineHeight: 16, color: fg() }}>
                    {source.sourceId}
                  </Text>
                  <StatusChip status={source.status} label={`${formatStatusLabel(source.status)} · ${source.itemCount}`} />
                </View>
                {source.reason ? (
                  <Text style={{ fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 15, color: fg(0.55) }}>
                    {source.reason}
                  </Text>
                ) : null}
                {source.connectors && source.connectors.length > 0 ? (
                  <View style={{ gap: 4 }}>
                    {source.connectors.map((connector) => (
                      <View key={`${source.sourceId}-${connector.connectorId}`} style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={{ fontFamily: "Inter_500Medium", fontSize: 11, lineHeight: 15, color: fg(0.8) }}>
                            {connector.connectorId}
                          </Text>
                          {connector.reason ? (
                            <Text style={{ fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 15, color: fg(0.45) }}>
                              {connector.reason}
                            </Text>
                          ) : null}
                        </View>
                        <StatusChip status={connector.status} label={`${formatStatusLabel(connector.status)} · ${connector.itemCount}`} />
                      </View>
                    ))}
                  </View>
                ) : null}
              </View>
            ))}
            {detail.detail.sourceBreakdown.length === 0 ? (
              <Text style={{ fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 15, color: fg(0.45) }}>
                {t("evolution.noSourceResults")}
              </Text>
            ) : null}
          </View>
        </View>

        <View style={{ gap: 8 }}>
          <SectionH3>{t("evolution.candidateCards")}</SectionH3>
          {detail.detail.candidates.length > 0 ? (
            detail.detail.candidates.map((candidate) => (
              <View key={String(candidate.id)} style={{ borderRadius: 16, backgroundColor: fg(0.04), paddingHorizontal: 12, paddingVertical: 8 }}>
                <Text style={{ fontFamily: "Inter_500Medium", fontSize: 12, lineHeight: 16, color: fg() }}>
                  {String(candidate.title ?? candidate.id)}
                </Text>
                <Text style={{ marginTop: 4, fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 15, color: fg(0.45) }}>
                  {String(candidate.reason ?? "")}
                </Text>
              </View>
            ))
          ) : (
            <Text style={{ fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 15, color: fg(0.45) }}>
              {t("evolution.noCandidateCards")}
            </Text>
          )}
        </View>

        <Details summary={t("evolution.logsTitle")}>
          <View style={{ marginTop: 8, gap: 8 }}>
            {detail.detail.logPath ? (
              <Text style={{ fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: fg(0.45) }}>
                {detail.detail.logPath}
              </Text>
            ) : null}
            <ScrollView style={{ maxHeight: 192, borderRadius: 16, backgroundColor: fg(0.04) }} contentContainerStyle={{ padding: 12 }} nestedScrollEnabled>
              <Pre text={detail.detail.logText || t("evolution.noLogsYet")} />
            </ScrollView>
          </View>
        </Details>

        <Details summary={t("evolution.profileDiff")}>
          <ScrollView style={{ marginTop: 8, maxHeight: 192, borderRadius: 16, backgroundColor: fg(0.04) }} contentContainerStyle={{ padding: 12 }} nestedScrollEnabled>
            <Pre text={JSON.stringify(detail.detail.profileDelta, null, 2)} />
          </ScrollView>
        </Details>

        <Details summary={t("evolution.goalDiff")}>
          <ScrollView style={{ marginTop: 8, maxHeight: 192, borderRadius: 16, backgroundColor: fg(0.04) }} contentContainerStyle={{ padding: 12 }} nestedScrollEnabled>
            <Pre text={JSON.stringify(detail.detail.goalDelta, null, 2)} />
          </ScrollView>
        </Details>

        <View style={{ gap: 8 }}>
          <SectionH3>{t("evolution.goalChanges")}</SectionH3>
          {goalChanges.length > 0 ? (
            goalChanges.map((change, index) => (
              <View key={`goal-change-${index}`} style={{ borderRadius: 16, backgroundColor: fg(0.04), paddingHorizontal: 12, paddingVertical: 12, gap: 4 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <View style={{ borderRadius: 999, backgroundColor: fg(0.06), paddingHorizontal: 8, paddingVertical: 2 }}>
                    <Text style={{ fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: fg(0.55) }}>
                      {String(change.action ?? "update")}
                    </Text>
                  </View>
                  <Text style={{ flex: 1, fontFamily: "Inter_500Medium", fontSize: 12, lineHeight: 16, color: fg() }}>
                    {goalChangeTitle(change, index)}
                  </Text>
                </View>
                <Text style={{ fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 15, color: fg(0.55) }}>
                  {String(change.reason ?? "")}
                </Text>
                <ScrollView style={{ maxHeight: 160, borderRadius: 16, backgroundColor: fg(0.04) }} contentContainerStyle={{ padding: 12 }} nestedScrollEnabled>
                  <Pre text={JSON.stringify({ before: change.before ?? null, after: change.after ?? null }, null, 2)} />
                </ScrollView>
              </View>
            ))
          ) : (
            <Text style={{ fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 15, color: fg(0.45) }}>
              {t("evolution.noGoalChanges")}
            </Text>
          )}
        </View>

        <View style={{ gap: 8 }}>
          <SectionH3>{t("evolution.rawConnectorPayloads")}</SectionH3>
          {connectorGroups.length > 0 ? connectorGroups.map((group) => (
            <View key={`raw-${group.sourceId}`} style={{ gap: 8 }}>
              {group.connectors.map((connector) => (
                <Details
                  key={`raw-${group.sourceId}-${connector.connectorId}`}
                  summary={t("evolution.sourceItems", { source: connector.connectorId, count: connector.itemCount })}
                >
                  <ScrollView style={{ marginTop: 8, maxHeight: 256, borderRadius: 16, backgroundColor: fg(0.04) }} contentContainerStyle={{ padding: 12 }} nestedScrollEnabled>
                    <Pre text={JSON.stringify(connector.raw, null, 2)} />
                  </ScrollView>
                </Details>
              ))}
            </View>
          )) : (
            <Details summary={t("evolution.rawInputs")}>
              <ScrollView style={{ marginTop: 8, maxHeight: 256, borderRadius: 16, backgroundColor: fg(0.04) }} contentContainerStyle={{ padding: 12 }} nestedScrollEnabled>
                <Pre text={JSON.stringify(detail.detail.rawInputs, null, 2)} />
              </ScrollView>
            </Details>
          )}
        </View>

        {/* Phase 2a status badges — dreams write through automatically */}
        {[
          { label: t("evolution.profileChanges"), appliedAt: detail.run.applied_at },
          { label: t("evolution.goalChangesBadge"), appliedAt: detail.run.goals_applied_at },
        ].map(({ label, appliedAt }) => (
          <View key={label} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderRadius: 16, backgroundColor: fg(0.04), paddingHorizontal: 12, paddingVertical: 8 }}>
            <Text style={{ fontFamily: "Inter_400Regular", fontSize: 12, lineHeight: 16, color: fg(0.7) }}>{label}</Text>
            <Text style={{ fontFamily: "Inter_500Medium", fontSize: 12, lineHeight: 16, color: fg() }}>
              {detail.run.status === "running"
                ? t("evolution.applyPending")
                : detail.run.status === "failed"
                  ? t("evolution.applySkipped")
                  : appliedAt
                    ? t("evolution.appliedDuringRun")
                    : detail.run.superseded
                      ? t("evolution.supersededByNewer")
                      : t("evolution.applied")}
            </Text>
          </View>
        ))}
      </GlassCard>
    );
  }

  // ── Home view ──
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 12, lineHeight: 16, color: fg() }}>
            {t("evolution.title")}
          </Text>
          <Text style={{ marginTop: 4, fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 15, color: fg(0.42) }}>
            {scheduleLabel(schedule)}
          </Text>
        </View>
        <SettingsSwitch
          size="md"
          on={enabled}
          disabled={loading || saving}
          onPress={() => void handleToggle()}
          accessibilityLabel={t("evolution.title")}
        />
      </View>

      {latestRun ? (
        <View style={{ borderRadius: 16, backgroundColor: fg(0.04), paddingHorizontal: 12, paddingVertical: 12, gap: 4 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <Text style={{ fontFamily: "Inter_500Medium", fontSize: 12, lineHeight: 16, color: fg() }}>
              {t("evolution.latestRun")}
            </Text>
            <StatusChip status={latestRun.status} />
          </View>
          <Text style={{ fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 15, color: fg(0.6) }}>
            {latestRun.summary?.text ?? t("evolution.noSummaryYet")}
          </Text>
          <Text style={{ fontFamily: "Inter_400Regular", fontSize: 10, lineHeight: 14, color: fg(0.4) }}>
            {formatTimestamp(latestRun.started_at)}
          </Text>
        </View>
      ) : null}

      {/* Pressable 的 style 不渲染（项目坑）→ flex 由外层 View 承载。 */}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Pressable onPress={() => void handleRunDreaming()} disabled={startingRun || detailLoading}>
            <View
              style={{
                borderRadius: 16,
                backgroundColor: PRIMARY,
                paddingHorizontal: 12,
                paddingVertical: 8,
                alignItems: "center",
                opacity: startingRun || detailLoading ? 0.5 : 1,
              }}
            >
              <Text style={{ fontFamily: "Inter_500Medium", fontSize: 12, lineHeight: 16, color: BG }}>
                {startingRun ? t("evolution.starting") : t("evolution.runNow")}
              </Text>
            </View>
          </Pressable>
        </View>
        <View style={{ flex: 1 }}>
          <Pressable onPress={() => void loadHistory()}>
            <View style={{ borderRadius: 16, backgroundColor: fg(0.06), paddingHorizontal: 12, paddingVertical: 8, alignItems: "center" }}>
              <Text style={{ fontFamily: "Inter_500Medium", fontSize: 12, lineHeight: 16, color: fg() }}>
                {t("evolution.viewHistory")}
              </Text>
            </View>
          </Pressable>
        </View>
      </View>

      {notice ? (
        <Text style={{ fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 15, color: "rgba(5,150,105,0.9)" }}>
          {notice}
        </Text>
      ) : null}
      {error ? (
        <Text style={{ fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 15, color: "rgba(239,68,68,0.8)" }}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}
