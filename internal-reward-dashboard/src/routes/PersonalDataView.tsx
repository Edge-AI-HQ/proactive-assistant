import { Fragment, useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Database,
  Search,
  UserRound,
} from "lucide-react";
import { getPersonalData } from "@/api/reward";
import type {
  PersonalDataCategory,
  PersonalDataItem,
  PersonalDataResponse,
  PersonalDataSection,
} from "@/api/reward";
import { StateBlock } from "@/components/StateBlock";

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
  { key: "app_state", label: "应用状态", description: "本地迁移状态" },
  { key: "all", label: "全部概况", description: "每类最新样本" },
];

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
  auto_crystallize: "自动 crystallize",
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

function dayStart(value: string): string | undefined {
  return value ? new Date(`${value}T00:00:00`).toISOString() : undefined;
}

function dayEnd(value: string): string | undefined {
  return value ? new Date(`${value}T23:59:59.999`).toISOString() : undefined;
}

function formatTime(value: string | null | undefined): string {
  return value
    ? new Date(value).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "-";
}

function compactNumber(value: number | undefined): string {
  return typeof value === "number" ? value.toLocaleString() : "0";
}

function scoreText(value: number | null): string | null {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
  if (typeof value === "string") return value.trim() || "-";
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
    .slice(0, 28);
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
              <span>{fieldLabel(key)}</span>
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
          <span key={`${valueText(item, 40)}:${index}`}>{displayPrimitive(item)}</span>
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
            <span>{key}</span>
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
  const payload = payloadRecord(item);
  const facts = asRecord(payload.facts);
  const preferences = asRecord(payload.preferences);
  const constraints = asRecord(payload.constraints);
  const summary = valueText(payload.summary ?? item?.summary ?? "", 420);
  const profileTitle = item?.title ?? "用户画像";
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
    <aside className="personal-category-menu">
      <div className="menu-title">数据菜单</div>
      {categories.map((item) => {
        const total = item.key === "all" ? overview?.totals.all : findSection(overview, item.key)?.total;
        return (
          <button
            className={category === item.key ? "active" : ""}
            key={item.key}
            onClick={() => onChange(item.key)}
            type="button"
          >
            <span>
              <strong>{item.label}</strong>
              <small>{item.description}</small>
            </span>
            <em>{compactNumber(total)}</em>
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
          <span>{fieldLabel(key)}</span>
          <strong>{valueText(value, 360)}</strong>
        </div>
      ))}
    </div>
  );
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
      <table className="personal-table">
        <thead>
          <tr>
            <th>时间</th>
            <th>来源</th>
            <th>关键内容</th>
            <th>状态/分数</th>
            <th>字段</th>
          </tr>
        </thead>
        <tbody>
          {section.items.map((item) => {
            const itemKey = `${section.key}:${item.sourceKey}:${item.id}`;
            const score = scoreText(item.score);
            return (
              <Fragment key={itemKey}>
                <tr>
                  <td className="time-cell">{formatTime(item.occurredAt ?? item.updatedAt)}</td>
                  <td>
                    <div className="source-cell">
                      <strong>{item.sourceLabel}</strong>
                      {item.kind && <span>{item.kind}</span>}
                    </div>
                  </td>
                  <td>
                    <div className="content-cell">
                      <strong>{item.title}</strong>
                      {(item.subtitle || item.summary) && (
                        <span>{[item.subtitle, item.summary].filter(Boolean).join(" · ")}</span>
                      )}
                      {item.chips.length > 0 && (
                        <div className="data-chip-row compact">
                          {item.chips.slice(0, 5).map((chip) => <em key={chip}>{chip}</em>)}
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
                    <button className="plain-button row-detail-button" onClick={() => onToggle(itemKey)} type="button">
                      {expandedId === itemKey ? "收起" : "查看"}
                    </button>
                  </td>
                </tr>
                {expandedId === itemKey && (
                  <tr className="detail-row">
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
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="pagination-bar">
      <div className="pagination-controls">
        <select value={pageSize} onChange={(event) => onPageSizeChange(Number(event.target.value))}>
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

export function PersonalDataView() {
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
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const normalizedQuery = query.trim();
  const sinceIso = dayStart(since);
  const untilIso = dayEnd(until);
  const offset = category === "all" ? 0 : (page - 1) * pageSize;

  useEffect(() => {
    setPage(1);
    setExpandedId(null);
  }, [category, since, until, normalizedQuery, pageSize]);

  useEffect(() => {
    let cancelled = false;
    setOverviewLoading(true);
    getPersonalData({
      category: "all",
      since: sinceIso,
      until: untilIso,
      q: normalizedQuery || undefined,
      limit: 5,
      offset: 0,
    })
      .then((next) => {
        if (!cancelled) setOverview(next);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "加载失败");
      })
      .finally(() => {
        if (!cancelled) setOverviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sinceIso, untilIso, normalizedQuery]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getPersonalData({
      category,
      since: sinceIso,
      until: untilIso,
      q: normalizedQuery || undefined,
      limit: pageSize,
      offset,
    })
      .then((next) => {
        if (!cancelled) setData(next);
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
  }, [category, sinceIso, untilIso, normalizedQuery, pageSize, offset]);

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

  const selectedSection = category === "all" ? undefined : findSection(data, category);
  const profileSection = category === "profile" ? selectedSection : undefined;
  const visibleSections = data?.sections ?? [];
  const selectedTotal = category === "all" ? (data?.totals.all ?? 0) : (selectedSection?.total ?? 0);

  if (error) return <StateBlock title="个人数据加载失败" detail={error} />;

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
        <div className="personal-filter-grid">
          <label className="search-field">
            <span><Search size={14} /> 搜索</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="标题、摘要、字段内容" />
          </label>
          <label>
            <span><CalendarDays size={14} /> 开始日期</span>
            <input type="date" value={since} max={until || undefined} onChange={(event) => setSince(event.target.value)} />
          </label>
          <label>
            <span><CalendarDays size={14} /> 结束日期</span>
            <input type="date" value={until} min={since || undefined} max={today} onChange={(event) => setUntil(event.target.value)} />
          </label>
        </div>
        <div className="date-preset-row">
          <button onClick={() => applyRecent(1)} type="button">今天</button>
          <button onClick={() => applyRecent(7)} type="button">近 7 天</button>
          <button onClick={() => applyRecent(30)} type="button">近 30 天</button>
          <button onClick={clearDates} type="button">全部时间</button>
        </div>
      </section>

      <div className="personal-data-layout">
        <CategoryMenu
          category={category}
          onChange={setCategory}
          overview={overviewLoading && !overview ? null : overview}
        />
        <main className="personal-data-main">
          {category === "profile" && <ProfileSpotlight section={profileSection} />}

          {loading && <StateBlock title="正在读取个人数据" />}

          {data && !loading && (
            <>
              <div className="personal-section-list">
                {visibleSections.map((section) => (
                  <section className="panel personal-section-table" key={section.key}>
                    <div className="panel-head">
                      <div>
                        <div className="eyebrow">数据表</div>
                        <h2>
                          {section.label}（{section.total.toLocaleString()}）
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
        </main>
      </div>
    </div>
  );
}
