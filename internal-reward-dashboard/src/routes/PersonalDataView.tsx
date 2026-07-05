import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
  Database,
  ListChecks,
  RefreshCw,
  Search,
  UserRound,
} from "lucide-react";
import { getPersonalData, PERSONAL_DATA_OFFSET_MAX, PERSONAL_DATA_QUERY_MAX_LENGTH } from "@/api/reward";
import type {
  PersonalDataCategory,
  PersonalDataItem,
  PersonalDataResponse,
  PersonalDataSection,
} from "@/api/reward";
import { StateBlock } from "@/components/StateBlock";
import { copyText } from "@/lib/clipboard";
import { finiteCount, formatCount, pageWithinOffsetLimit, totalPagesForOffsetLimit } from "@/lib/count";
import { dashboardRoutes } from "@/lib/dashboardRoutes";
import { formatDateTimeOrDash } from "@/lib/dateFormat";
import { dateRangeOrderError, dayEndIso, dayStartIso } from "@/lib/dateRange";
import { shouldWaitForPageReset } from "@/lib/pageReset";
import { normalizePageSize } from "@/lib/pageSize";
import { isSensitiveKey, redactSensitivePayload, redactedSecretText } from "@/lib/redaction";

const categories: Array<{ key: PersonalDataCategory; label: string; description: string }> = [
  { key: "profile", label: "画像", description: "事实、偏好、约束" },
  { key: "settings", label: "设置", description: "生成和采集偏好" },
  { key: "goals", label: "目标", description: "长期方向" },
  { key: "memory", label: "记忆", description: "长期事实" },
  { key: "skills", label: "技能", description: "可复用工作方式" },
  { key: "signals", label: "个人信号", description: "短期观察" },
  { key: "raw", label: "原始数据", description: "连接器和设备记录" },
  { key: "world", label: "世界信号", description: "外部信息" },
  { key: "devices", label: "设备", description: "设备状态" },
  { key: "connectors", label: "连接器", description: "账号和同步游标" },
  { key: "all", label: "全部概况", description: "每类最新样本" },
];
const categoryKeys = new Set<string>(categories.map((item) => item.key));

interface PersonalDataViewProps {
  onNavigate: (path: string) => void;
}

interface PersonalDataQueryState {
  category: PersonalDataCategory;
  limit: number;
  offset: number;
  query: string;
  since: string | undefined;
  until: string | undefined;
}

interface PersonalDataOverviewQueryState {
  query: string;
  since: string | undefined;
  until: string | undefined;
}

const hiddenPayloadKeys = new Set([
  "embedding_model",
  "embedded_at",
  "referenced_by_runs",
  "related_memory_ids",
  "source_raw_ids",
  "metadata",
]);

const labelMap: Record<string, string> = {
  facts: "事实",
  preferences: "偏好",
  constraints: "约束",
  summary: "摘要",
  display_name: "名称",
  locale: "语言",
  timezone: "时区",
  generation_language: "生成语言",
  auto_generate: "自动生成",
  auto_dreaming: "自动 dreaming",
  dreaming: "后台生成",
  sourceStats: "来源统计",
  cards: "卡片",
  signals: "信号",
  feedback: "反馈",
  personal: "个人数据",
  count: "数量",
  lastUpdatedAt: "最后更新时间",
  lastRunAt: "最近运行时间",
  lastWindowStart: "最近窗口开始",
  lastWindowEnd: "最近窗口结束",
  lastSummaryKind: "摘要类型",
  latestCandidates: "最新候选",
  latestHighlights: "最新重点",
  lastCandidateCount: "候选数量",
  status: "状态",
  source: "来源",
  quality: "质量",
  confidence: "置信度",
  salience: "显著性",
  occurred_at: "发生时间",
  updated_at: "更新时间",
  created_at: "创建时间",
  ingested_at: "入库时间",
  reference_count: "引用次数",
};

function dateValue(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function formatTime(value: string | null | undefined): string {
  return formatDateTimeOrDash(value, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }, "zh-CN");
}

function scoreText(value: number | null): string | null {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : null;
}

function detailRowId(itemKey: string): string {
  return `personal-data-detail-${encodeURIComponent(itemKey).replace(/%/g, "_")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableStringField(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function countField(value: unknown, fallback = 0): number {
  return typeof value === "number" ? finiteCount(value, fallback) : fallback;
}

function categoryField(value: unknown, fallback: PersonalDataCategory): PersonalDataCategory {
  return typeof value === "string" && categoryKeys.has(value) ? value as PersonalDataCategory : fallback;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function itemPayload(value: unknown): PersonalDataItem["payload"] {
  return value === null || typeof value === "string" || Array.isArray(value) || isRecord(value) ? value : null;
}

export function personalDataItem(value: unknown, fallbackCategory: PersonalDataCategory): PersonalDataItem | null {
  if (!isRecord(value)) return null;
  const id = stringField(value.id);
  if (!id) return null;
  return {
    id,
    category: categoryField(value.category, fallbackCategory),
    sourceKey: stringField(value.sourceKey),
    sourceLabel: stringField(value.sourceLabel, "未知来源"),
    kind: nullableStringField(value.kind),
    title: stringField(value.title, "未命名数据"),
    subtitle: nullableStringField(value.subtitle),
    summary: nullableStringField(value.summary),
    status: nullableStringField(value.status),
    score: typeof value.score === "number" && Number.isFinite(value.score) ? value.score : null,
    occurredAt: nullableStringField(value.occurredAt),
    updatedAt: nullableStringField(value.updatedAt),
    chips: stringList(value.chips),
    payload: itemPayload(value.payload),
  };
}

export function personalDataSections(value: unknown): PersonalDataSection[] {
  return Array.isArray(value)
    ? value.flatMap((section): PersonalDataSection[] => {
        if (!isRecord(section)) return [];
        const key = categoryField(section.key, "all");
        if (key === "all") return [];
        const categoryMeta = categories.find((item) => item.key === key);
        const items = Array.isArray(section.items)
          ? section.items
              .map((item) => personalDataItem(item, key))
              .filter((item): item is PersonalDataItem => item !== null)
          : [];
        return [{
          key,
          label: stringField(section.label, categoryMeta?.label ?? key),
          description: stringField(section.description, categoryMeta?.description ?? ""),
          total: countField(section.total, items.length),
          items,
        }];
      })
    : [];
}

export function personalDataResponse(value: unknown): PersonalDataResponse | null {
  if (!isRecord(value)) return null;
  const filters = isRecord(value.filters) ? value.filters : {};
  const totalsRecord = isRecord(value.totals) ? value.totals : {};
  const totals = Object.fromEntries(
    Object.entries(totalsRecord).map(([key, total]) => [key, countField(total)]),
  );
  const sections = personalDataSections(value.sections);
  if (totals.all === undefined) {
    totals.all = sections.reduce((sum, section) => sum + countField(section.total, section.items.length), 0);
  }
  return {
    ok: true,
    filters: {
      category: categoryField(filters.category, "all"),
      since: nullableStringField(filters.since),
      until: nullableStringField(filters.until),
      query: nullableStringField(filters.query),
      limit: countField(filters.limit),
      offset: countField(filters.offset),
    },
    totals,
    sections,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function payloadRecord(item: PersonalDataItem | null | undefined): Record<string, unknown> {
  return isRecord(item?.payload) ? item.payload : {};
}

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

function fieldLabel(key: string): string {
  return labelMap[key] ?? key.replace(/_/g, " ");
}

function valueText(value: unknown, max = 180): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "-";
  if (typeof value === "string") {
    const text = value.replace(/\s+/g, " ").trim();
    if (!text) return "-";
    return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1)).trim()}...`;
  }
  if (Array.isArray(value)) return value.map((item) => valueText(item, 80)).filter(Boolean).join("、") || "-";
  if (isRecord(value)) {
    const preferred = ["title", "summary", "text", "name", "value"]
      .map((key) => value[key])
      .find(hasValue);
    if (preferred) return valueText(preferred, max);
    const text = JSON.stringify(value);
    return text.length > max ? `${text.slice(0, max)}...` : text;
  }
  return String(value);
}

function looksLikeIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T/.test(value);
}

function displayPrimitive(value: unknown): string {
  if (typeof value === "string" && looksLikeIsoDate(value)) return formatTime(value);
  return valueText(value, 220);
}

function profileEntries(record: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(record).filter(([, value]) => hasValue(value));
}

function flattenProfileEntries(
  record: Record<string, unknown>,
  prefix = "",
  depth = 0,
): Array<[string, unknown]> {
  return profileEntries(record).flatMap(([key, value]) => {
    const label = prefix ? `${prefix} / ${fieldLabel(key)}` : fieldLabel(key);
    if (isRecord(value) && depth < 2) {
      return flattenProfileEntries(value, label, depth + 1);
    }
    return [[label, value]];
  });
}

function payloadEntries(item: PersonalDataItem): Array<[string, unknown]> {
  return Object.entries(payloadRecord(item))
    .filter(([key, value]) => !hiddenPayloadKeys.has(key) && hasValue(value))
    .map(([key, value]) => [
      key,
      isSensitiveKey(key) ? redactedSecretText : redactSensitivePayload(value),
    ] as [string, unknown])
    .slice(0, 28);
}

export function personalDataDisplayPayload(item: PersonalDataItem | null | undefined): Record<string, unknown> {
  const payload = payloadRecord(item);
  const redacted = redactSensitivePayload(payload);
  return isRecord(redacted) ? redacted : {};
}

function findSection(data: PersonalDataResponse | null, key: PersonalDataCategory): PersonalDataSection | undefined {
  return data?.sections.find((section) => section.key === key);
}

function ProfileBucket({
  title,
  record,
  empty,
}: {
  title: string;
  record: Record<string, unknown>;
  empty: string;
}) {
  const entries = flattenProfileEntries(record).slice(0, 36);
  return (
    <div className="profile-bucket">
      <h3>{title}</h3>
      {entries.length > 0 ? (
        <div className="profile-field-list">
          {entries.map(([key, value]) => (
            <div className="profile-field" key={key}>
              <span>{valueText(fieldLabel(key), 120)}</span>
              <ProfileValue value={value} />
            </div>
          ))}
        </div>
      ) : (
        <p>{empty}</p>
      )}
    </div>
  );
}

function ProfileValue({ value }: { value: unknown }) {
  if (Array.isArray(value)) {
    return (
      <div className="profile-chip-list">
        {value.slice(0, 10).map((item, index) => (
          <span key={`profile-chip-${index}`}>{displayPrimitive(item)}</span>
        ))}
      </div>
    );
  }

  if (isRecord(value)) {
    const entries = flattenProfileEntries(value).slice(0, 12);
    if (entries.length === 0) return <strong>-</strong>;
    return (
      <div className="profile-nested-list">
        {entries.map(([key, nestedValue]) => (
          <div key={key}>
            <span>{valueText(key, 120)}</span>
            <strong>{displayPrimitive(nestedValue)}</strong>
          </div>
        ))}
      </div>
    );
  }

  return <strong>{displayPrimitive(value)}</strong>;
}

function ProfileSpotlight({ section }: { section: PersonalDataSection | undefined }) {
  const item = section?.items[0];
  const payload = personalDataDisplayPayload(item);
  const facts = asRecord(payload.facts);
  const preferences = asRecord(payload.preferences);
  const constraints = asRecord(payload.constraints);
  const summary = valueText(payload.summary ?? item?.summary ?? "", 420);
  const profileTitle = valueText(item?.title ?? "用户画像", 180);
  const locale = valueText(payload.locale ?? "", 80);
  const timezone = valueText(payload.timezone ?? "", 80);

  return (
    <section className="panel profile-spotlight">
      <div className="profile-spotlight-head">
        <div>
          <div className="eyebrow">用户画像</div>
          <h2>{profileTitle}</h2>
          <p>{summary === "-" ? "还没有沉淀出画像摘要。" : summary}</p>
          <div className="profile-meta-row">
            {locale !== "-" && <span>{locale}</span>}
            {timezone !== "-" && <span>{timezone}</span>}
          </div>
        </div>
        <div className="profile-spotlight-meta">
          <UserRound size={18} />
          <span>{item ? `更新于 ${formatTime(item.updatedAt)}` : "暂无画像"}</span>
        </div>
      </div>
      <div className="profile-bucket-stack">
        <ProfileBucket title="偏好" record={preferences} empty="暂无偏好记录。" />
        <ProfileBucket title="事实" record={facts} empty="暂无事实记录。" />
        <ProfileBucket title="约束" record={constraints} empty="暂无约束记录。" />
      </div>
    </section>
  );
}

function CategoryMenu({
  overview,
  category,
  onChange,
}: {
  overview: PersonalDataResponse | null;
  category: PersonalDataCategory;
  onChange: (category: PersonalDataCategory) => void;
}) {
  return (
    <aside className="personal-category-menu" aria-label="个人数据分类">
      <div className="menu-title">数据菜单</div>
      {categories.map((item) => {
        const total = item.key === "all" ? overview?.totals.all : findSection(overview, item.key)?.total;
        return (
          <button
            aria-pressed={category === item.key}
            className={category === item.key ? "active" : ""}
            key={item.key}
            onClick={() => onChange(item.key)}
            type="button"
          >
            <span>
              <strong>{item.label}</strong>
              <small>{item.description}</small>
            </span>
            <em>{formatCount(total)}</em>
          </button>
        );
      })}
    </aside>
  );
}

function DataFieldPreview({ item }: { item: PersonalDataItem }) {
  const entries = payloadEntries(item);
  if (entries.length === 0) return <div className="muted">没有额外字段。</div>;
  return (
    <div className="data-field-grid">
      {entries.map(([key, value]) => (
        <div key={key}>
          <span>{valueText(fieldLabel(key), 120)}</span>
          <strong>{valueText(value, 360)}</strong>
        </div>
      ))}
    </div>
  );
}

export function personalDataMarkdown(
  data: PersonalDataResponse | null,
  options: {
    categoryLabel: string;
    query: string;
    selectedTotal: number;
    timeRangeLabel: string;
  },
): string {
  const normalizedData = personalDataResponse(data);
  if (!normalizedData || normalizedData.sections.length === 0) return "";
  const lines = [
    `### 个人数据视图 ${options.categoryLabel}`,
    "",
    `- 时间范围: ${options.timeRangeLabel}`,
    `- 搜索: ${options.query || "无"}`,
    `- 筛选命中: ${formatCount(options.selectedTotal)}`,
    `- 当前页条目: ${normalizedData.sections.reduce((sum, section) => sum + section.items.length, 0)}`,
  ];

  normalizedData.sections.forEach((section) => {
    lines.push("", `#### ${section.label} (${formatCount(section.total)})`);
    if (section.items.length === 0) {
      lines.push("- 当前页没有数据。");
      return;
    }
    const visibleItems = section.items.slice(0, 12);
    visibleItems.forEach((item, index) => {
      const time = formatTime(item.occurredAt ?? item.updatedAt);
      const score = scoreText(item.score);
      const allPayloadEntries = payloadEntries(item);
      const detailLines = allPayloadEntries
        .slice(0, 5)
        .map(([key, value]) => `  - ${fieldLabel(key)}: ${valueText(value, 180)}`);
      if (allPayloadEntries.length > detailLines.length) {
        detailLines.push(`  - 还有 ${allPayloadEntries.length - detailLines.length} 个字段未写入复制摘要，请回到个人数据页面继续查看。`);
      }
      lines.push(
        `${index + 1}. ${valueText(item.title, 140)}`,
        `  - 来源: ${valueText(item.sourceLabel, 120)}${item.kind ? ` / ${valueText(item.kind, 80)}` : ""}`,
        `  - 时间: ${time}`,
        `  - 状态/分数: ${[item.status, score].filter(Boolean).join(" / ") || "-"}`,
        `  - 摘要: ${valueText(item.summary ?? item.subtitle, 360)}`,
      );
      if (item.chips.length > 0) {
        lines.push(`  - 标签: ${item.chips.slice(0, 6).map((chip) => valueText(chip, 80)).join(", ")}`);
      }
      lines.push(...detailLines);
    });
    if (section.items.length > visibleItems.length) {
      lines.push(`- 还有 ${section.items.length - visibleItems.length} 条当前页数据未写入复制摘要，请回到个人数据页面继续查看。`);
    }
  });

  return lines.join("\n");
}

export function overviewSummaryText({
  activeCategoryCount,
  overviewError,
  overviewLoading,
}: {
  activeCategoryCount: number;
  overviewError: string | null;
  overviewLoading: boolean;
}): string {
  if (overviewError) return "概况刷新失败。";
  if (overviewLoading) return "正在刷新概况。";
  return `${activeCategoryCount} 类有数据。`;
}

function personalDataQueryKey(query: PersonalDataQueryState): string {
  return JSON.stringify(query);
}

function personalDataOverviewQueryKey(query: PersonalDataOverviewQueryState): string {
  return JSON.stringify(query);
}

function isCurrentLoadedDataQuery(currentQueryKey: string, loadedQueryKey: string | null): boolean {
  return loadedQueryKey !== null && loadedQueryKey === currentQueryKey;
}

export function personalDataBlockingError(
  error: string | null,
  hasLoaded: boolean,
  currentQueryKey = "",
  loadedQueryKey: string | null = null,
  filterValidationError: string | null = null,
): boolean {
  void currentQueryKey;
  void loadedQueryKey;
  if (filterValidationError) return false;
  return error !== null && !hasLoaded;
}

export function personalDataRefreshErrorText(
  error: string | null,
  hasLoaded: boolean,
  currentQueryKey = "",
  loadedQueryKey: string | null = null,
): string | null {
  if (!error || !hasLoaded) return null;
  if (isCurrentLoadedDataQuery(currentQueryKey, loadedQueryKey)) {
    return `个人数据刷新失败，当前仍显示上一次成功加载的数据：${error}`;
  }
  return `个人数据刷新失败，当前筛选还没有成功加载结果：${error}`;
}

export function personalDataHideStaleRows(hasLoaded: boolean, currentQueryKey: string, loadedQueryKey: string | null): boolean {
  return hasLoaded && !isCurrentLoadedDataQuery(currentQueryKey, loadedQueryKey);
}

export function personalDataHideStaleOverview(currentQueryKey: string, loadedQueryKey: string | null): boolean {
  return loadedQueryKey !== null && loadedQueryKey !== currentQueryKey;
}

export function personalDataFilterError({
  query = "",
  since,
  until,
}: {
  query?: string;
  since: string;
  until: string;
}): string | null {
  if (query.trim().length > PERSONAL_DATA_QUERY_MAX_LENGTH) {
    return `个人数据搜索词最多 ${PERSONAL_DATA_QUERY_MAX_LENGTH} 个字符。`;
  }
  return dateRangeOrderError(since, until, "个人数据时间");
}

export function canCopyPersonalDataView(
  data: PersonalDataResponse | null,
  loading: boolean,
  error: string | null = null,
): boolean {
  return !loading && error === null && data !== null;
}

export function personalDataCopyUnavailableMessage(
  loading: boolean,
  error: string | null,
  filterValidationError: string | null,
): string {
  if (filterValidationError) return "当前筛选条件无效，先修正后再复制。";
  if (loading) return "正在读取当前视图，加载完成后再复制。";
  if (error) return "当前视图刷新失败，先重新加载成功后再复制。";
  return "当前视图没有可复制上下文。";
}

export function personalDataEmptyStateTitle(filterValidationError: string | null): string {
  return filterValidationError ? "个人数据筛选条件无效" : "个人数据加载失败";
}

export function personalDataNoSectionsMessage(categoryLabel: string | undefined): string {
  return `当前筛选下没有${categoryLabel ?? "个人"}数据。`;
}

function DataTable({
  section,
  expandedId,
  onToggle,
}: {
  section: PersonalDataSection;
  expandedId: string | null;
  onToggle: (id: string) => void;
}) {
  if (section.items.length === 0) {
    return <div className="empty-data-panel">当前筛选条件下没有这类数据。</div>;
  }

  return (
    <div className="personal-table-wrap">
      <table aria-label="个人数据列表" className="personal-table">
        <thead>
          <tr>
            <th scope="col">时间</th>
            <th scope="col">来源</th>
            <th scope="col">关键内容</th>
            <th scope="col">状态/分数</th>
            <th scope="col">字段</th>
          </tr>
        </thead>
        <tbody>
          {section.items.map((item, itemIndex) => {
            const itemKey = `${section.key}:${itemIndex}:${item.sourceKey}:${item.id}`;
            const detailsId = detailRowId(itemKey);
            const isExpanded = expandedId === itemKey;
            const score = scoreText(item.score);
            return (
              <Fragment key={itemKey}>
                <tr>
                  <td className="time-cell">{formatTime(item.occurredAt ?? item.updatedAt)}</td>
                  <td>
                    <div className="source-cell">
                      <strong>{valueText(item.sourceLabel, 120)}</strong>
                      {item.kind && <span>{valueText(item.kind, 80)}</span>}
                    </div>
                  </td>
                  <td>
                    <div className="content-cell">
                      <strong>{valueText(item.title, 180)}</strong>
                      {(item.subtitle || item.summary) && (
                        <span>{[item.subtitle, item.summary].filter(Boolean).map((value) => valueText(value, 220)).join(" · ")}</span>
                      )}
                      {item.chips.length > 0 && (
                        <div className="data-chip-row compact">
                          {item.chips.slice(0, 5).map((chip, chipIndex) => <em key={`chip-${chipIndex}`}>{valueText(chip, 80)}</em>)}
                        </div>
                      )}
                    </div>
                  </td>
                  <td>
                    <div className="status-stack">
                      {item.status && <span className="data-status">{item.status}</span>}
                      {score && <span className="data-score">{score}</span>}
                      {!item.status && !score && <span className="muted">-</span>}
                    </div>
                  </td>
                  <td>
                    <button
                      aria-controls={detailsId}
                      aria-expanded={isExpanded}
                      className="plain-button row-detail-button"
                      onClick={() => onToggle(itemKey)}
                      type="button"
                    >
                      {isExpanded ? "收起" : "查看"}
                    </button>
                  </td>
                </tr>
                {isExpanded && (
                  <tr className="detail-row" id={detailsId}>
                    <td colSpan={5}>
                      <DataFieldPreview item={item} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PaginationBar({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}) {
  const totalPages = totalPagesForOffsetLimit(total, pageSize, PERSONAL_DATA_OFFSET_MAX);
  return (
    <div className="pagination-bar">
      <div className="pagination-controls">
        <select
          aria-label="个人数据每页条数"
          value={pageSize}
          onChange={(event) => onPageSizeChange(normalizePageSize(Number(event.target.value), [20, 40, 80], 40))}
        >
          <option value={20}>20 条/页</option>
          <option value={40}>40 条/页</option>
          <option value={80}>80 条/页</option>
        </select>
        <button disabled={page <= 1} onClick={() => onPageChange(page - 1)} type="button">
          <ChevronLeft size={16} />
          上一页
        </button>
        <span>{page} / {totalPages}</span>
        <button disabled={page >= totalPages} onClick={() => onPageChange(page + 1)} type="button">
          下一页
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}

export function PersonalDataView({ onNavigate }: PersonalDataViewProps) {
  const today = useMemo(() => dateValue(new Date()), []);
  const [category, setCategory] = useState<PersonalDataCategory>("profile");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [query, setQuery] = useState("");
  const [pageSize, setPageSize] = useState(40);
  const [page, setPage] = useState(1);
  const [overview, setOverview] = useState<PersonalDataResponse | null>(null);
  const [data, setData] = useState<PersonalDataResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [loadedOverviewQueryKey, setLoadedOverviewQueryKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loadedDataQueryKey, setLoadedDataQueryKey] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  const normalizedQuery = query.trim();
  const sinceIso = dayStartIso(since);
  const untilIso = dayEndIso(until);
  const filterValidationError = personalDataFilterError({ query: normalizedQuery, since, until });
  const offset = category === "all" ? 0 : (page - 1) * pageSize;
  const overviewQueryKey = personalDataOverviewQueryKey({
    query: normalizedQuery,
    since: sinceIso,
    until: untilIso,
  });
  const dataFilterKey = personalDataQueryKey({
    category,
    limit: pageSize,
    offset: 0,
    query: normalizedQuery,
    since: sinceIso,
    until: untilIso,
  });
  const dataQueryKey = personalDataQueryKey({
    category,
    limit: pageSize,
    offset,
    query: normalizedQuery,
    since: sinceIso,
    until: untilIso,
  });
  const previousDataFilterKey = useRef(dataFilterKey);

  useEffect(() => {
    setExpandedId(null);
    setCopyMessage(null);
  }, [page]);

  useEffect(() => {
    let cancelled = false;
    const requestQueryKey = overviewQueryKey;
    setOverviewLoading(true);
    setOverviewError(null);
    if (filterValidationError) {
      setOverviewLoading(false);
      setOverviewError(filterValidationError);
      return () => {
        cancelled = true;
      };
    }
    getPersonalData({
      category: "all",
      since: sinceIso,
      until: untilIso,
      q: normalizedQuery || undefined,
      limit: 5,
      offset: 0,
    })
      .then((next) => {
        if (!cancelled) {
          setOverview(personalDataResponse(next));
          setLoadedOverviewQueryKey(requestQueryKey);
        }
      })
      .catch((err) => {
        if (!cancelled) setOverviewError(err instanceof Error ? err.message : "加载失败");
      })
      .finally(() => {
        if (!cancelled) setOverviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sinceIso, untilIso, normalizedQuery, overviewQueryKey, reloadNonce]);

  useEffect(() => {
    let cancelled = false;
    const requestQueryKey = dataQueryKey;
    const filterChanged = dataFilterKey !== previousDataFilterKey.current;
    if (filterChanged) {
      previousDataFilterKey.current = dataFilterKey;
      setExpandedId(null);
      setCopyMessage(null);
      if (shouldWaitForPageReset(filterChanged, page)) {
        setPage(1);
        return () => {
          cancelled = true;
        };
      }
    }
    setLoading(true);
    setError(null);
    if (filterValidationError) {
      setLoading(false);
      setError(filterValidationError);
      return () => {
        cancelled = true;
      };
    }
    getPersonalData({
      category,
      since: sinceIso,
      until: untilIso,
      q: normalizedQuery || undefined,
      limit: pageSize,
      offset,
    })
      .then((next) => {
        if (!cancelled) {
          const normalizedNext = personalDataResponse(next);
          if (!normalizedNext) {
            setData(null);
            setHasLoaded(true);
            setLoadedDataQueryKey(requestQueryKey);
            return;
          }
          const selectedNextTotal = finiteCount(
            category === "all" ? normalizedNext.totals.all : findSection(normalizedNext, category)?.total,
          );
          const nextPage = category === "all"
            ? 1
            : pageWithinOffsetLimit(page, selectedNextTotal, pageSize, PERSONAL_DATA_OFFSET_MAX);
          if (nextPage !== page) {
            setPage(nextPage);
            return;
          }
          setData(normalizedNext);
          setHasLoaded(true);
          setLoadedDataQueryKey(requestQueryKey);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "加载失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dataFilterKey, dataQueryKey, page, reloadNonce]);

  function applyRecent(days: number) {
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - days + 1);
    setSince(dateValue(start));
    setUntil(dateValue(end));
  }

  function clearDates() {
    setSince("");
    setUntil("");
  }

  function refreshPersonalDataView() {
    setExpandedId(null);
    setCopyMessage(null);
    setReloadNonce((value) => value + 1);
  }

  async function copyCurrentView() {
    if (!canCopyPersonalDataView(visibleData, visibleLoading, error)) {
      setCopyMessage(personalDataCopyUnavailableMessage(visibleLoading, error, filterValidationError));
      return;
    }
    const markdown = personalDataMarkdown(visibleData, {
      categoryLabel: selectedCategory?.label ?? "全部",
      query: normalizedQuery,
      selectedTotal,
      timeRangeLabel,
    });
    if (!markdown.trim()) {
      setCopyMessage("当前视图没有可复制上下文。");
      return;
    }
    const copied = await copyText(markdown);
    setCopyMessage(copied ? "已复制当前个人数据视图。" : "当前浏览器不支持自动复制，请从表格内容手动复制。");
  }

  const hideStaleRows = personalDataHideStaleRows(hasLoaded, dataQueryKey, loadedDataQueryKey);
  const hideStaleOverview = personalDataHideStaleOverview(overviewQueryKey, loadedOverviewQueryKey);
  const visibleOverview = hideStaleOverview ? null : overview;
  const visibleOverviewLoading = overviewLoading || (hideStaleOverview && overviewError === null);
  const visibleData = hideStaleRows ? null : data;
  const visibleLoading = loading || (hideStaleRows && error === null);
  const selectedSection = category === "all" ? undefined : findSection(visibleData, category);
  const profileSection = category === "profile" ? selectedSection : undefined;
  const visibleSections = visibleData?.sections ?? [];
  const selectedTotal = finiteCount(category === "all" ? visibleData?.totals.all : selectedSection?.total);
  const selectedCategory = categories.find((item) => item.key === category);
  const activeCategoryCount = visibleOverview
    ? categories.filter((item) => item.key !== "all" && finiteCount(visibleOverview.totals[item.key]) > 0).length
    : 0;
  const visibleItemCount = visibleSections.reduce((sum, section) => sum + section.items.length, 0);
  const timeRangeLabel = since || until
    ? `${since || "最早"} - ${until || "今天"}`
    : "全部时间";
  const refreshErrorText = filterValidationError
    ? null
    : personalDataRefreshErrorText(error, hasLoaded, dataQueryKey, loadedDataQueryKey);
  const copyEnabled = canCopyPersonalDataView(visibleData, visibleLoading, error);

  if (personalDataBlockingError(error, hasLoaded, dataQueryKey, loadedDataQueryKey, filterValidationError)) {
    return (
      <div className="stack">
        <div className="view-toolbar">
          <button className="plain-button" onClick={() => onNavigate(dashboardRoutes.runs)} type="button">
            <ListChecks size={16} /> 批次列表
          </button>
          <div className="toolbar-actions">
            <button className="plain-button" onClick={() => onNavigate(dashboardRoutes.casebook)} type="button">
              <CheckCircle2 size={16} /> 样本库
            </button>
            <button className="plain-button" onClick={refreshPersonalDataView} disabled={loading} type="button">
              <RefreshCw size={16} /> 重新加载
            </button>
          </div>
        </div>
        <StateBlock title="个人数据加载失败" detail={error ?? undefined} />
      </div>
    );
  }

  return (
    <div className="personal-data-page">
      <section className="panel personal-data-control dense">
        <div className="panel-head">
          <div>
            <h2>个人数据</h2>
            <p>按生成链路真实读取的数据面查看：画像优先，其次是目标、记忆、技能、信号和 raw 数据。</p>
          </div>
          <Database size={22} />
        </div>
        <div className="personal-workflow-actions" aria-label="上下文检查后的复盘动作">
          <button className="plain-button" onClick={() => onNavigate(dashboardRoutes.runs)} type="button">
            <ListChecks size={15} /> 回评审
          </button>
          <button className="plain-button" onClick={() => onNavigate(dashboardRoutes.casebook)} type="button">
            <CheckCircle2 size={15} /> 样本库
          </button>
          <button className="plain-button" onClick={refreshPersonalDataView} disabled={loading || overviewLoading} type="button">
            <RefreshCw size={15} /> 刷新上下文
          </button>
          <button
            className="plain-button"
            disabled={!copyEnabled}
            onClick={() => void copyCurrentView()}
            title={copyEnabled ? "复制当前个人数据视图" : personalDataCopyUnavailableMessage(visibleLoading, error, filterValidationError)}
            type="button"
          >
            <ClipboardCopy size={15} /> 复制当前视图
          </button>
        </div>
        {copyMessage && <div className="inline-status" role="status">{copyMessage}</div>}
        {filterValidationError && <div className="inline-error" role="alert">{filterValidationError}</div>}
        {!filterValidationError && overviewError && <div className="inline-error" role="alert">概况刷新失败：{overviewError}</div>}
        {refreshErrorText && <div className="inline-error" role="alert">{refreshErrorText}</div>}
        <div className="personal-filter-grid">
          <label className="search-field">
            <span><Search size={14} /> 搜索</span>
            <input
              aria-label="搜索个人数据"
              maxLength={PERSONAL_DATA_QUERY_MAX_LENGTH}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="标题、摘要、字段内容"
            />
          </label>
          <label>
            <span><CalendarDays size={14} /> 开始日期</span>
            <input aria-label="个人数据开始日期" type="date" value={since} max={until || undefined} onChange={(event) => setSince(event.target.value)} />
          </label>
          <label>
            <span><CalendarDays size={14} /> 结束日期</span>
            <input aria-label="个人数据结束日期" type="date" value={until} min={since || undefined} max={today} onChange={(event) => setUntil(event.target.value)} />
          </label>
        </div>
        <div className="date-preset-row">
          <button onClick={() => applyRecent(1)} type="button">今天</button>
          <button onClick={() => applyRecent(7)} type="button">近 7 天</button>
          <button onClick={() => applyRecent(30)} type="button">近 30 天</button>
          <button onClick={clearDates} type="button">全部时间</button>
        </div>
        <div className="personal-summary-grid">
          <div>
            <span>总上下文</span>
            <strong>{formatCount(visibleOverview?.totals.all)}</strong>
            <p>{overviewSummaryText({ activeCategoryCount, overviewError, overviewLoading: visibleOverviewLoading })}</p>
          </div>
          <div>
            <span>当前视图</span>
            <strong>{selectedCategory?.label ?? "全部"}</strong>
            <p>{selectedCategory?.description ?? "每类最新样本"}</p>
          </div>
          <div>
            <span>筛选命中</span>
            <strong>{formatCount(selectedTotal)}</strong>
            <p>当前页展示 {visibleItemCount} 条。</p>
          </div>
          <div>
            <span>时间范围</span>
            <strong>{timeRangeLabel}</strong>
            <p>{normalizedQuery ? `搜索：${valueText(normalizedQuery, 120)}` : "没有搜索词。"}</p>
          </div>
        </div>
      </section>

      <div className="personal-data-layout">
        <CategoryMenu
          category={category}
          onChange={setCategory}
          overview={visibleOverviewLoading && !visibleOverview ? null : visibleOverview}
        />
        <section aria-label="个人数据明细" className="personal-data-main">
          {category === "profile" && <ProfileSpotlight section={profileSection} />}

          {visibleLoading && <StateBlock title="正在读取个人数据" />}

          {!visibleLoading && !visibleData && error && (
            <StateBlock
              title={personalDataEmptyStateTitle(filterValidationError)}
              detail={error}
            />
          )}

          {visibleData && !visibleLoading && visibleSections.length === 0 && (
            <StateBlock
              title="当前视图没有个人数据"
              detail={personalDataNoSectionsMessage(selectedCategory?.label)}
            />
          )}

          {visibleData && !visibleLoading && visibleSections.length > 0 && (
            <>
              <div className="personal-section-list">
                {visibleSections.map((section) => (
                  <section className="panel personal-section-table" key={section.key}>
                    <div className="panel-head">
                      <div>
                        <div className="eyebrow">数据表</div>
                        <h2>
                          {section.label}（{formatCount(section.total)}）
                        </h2>
                        <p>{section.description}</p>
                      </div>
                    </div>
                    <DataTable
                      expandedId={expandedId}
                      onToggle={(id) => setExpandedId((current) => (current === id ? null : id))}
                      section={section}
                    />
                    {category !== "all" && (
                      <PaginationBar
                        page={page}
                        pageSize={pageSize}
                        total={selectedTotal}
                        onPageChange={setPage}
                        onPageSizeChange={setPageSize}
                      />
                    )}
                  </section>
                ))}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
