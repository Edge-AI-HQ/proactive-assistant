import { useEffect, useMemo, useState, type ChangeEvent } from "react";

type JsonRecord = Record<string, unknown>;

type MemoryEntry = {
  id?: string;
  category?: string;
  text?: string;
  status?: string;
  score?: number;
  evidenceCount?: number;
  metadata?: JsonRecord;
  lastConfirmedAt?: string | null;
};

type MemoryEvent = {
  id?: string;
  source?: string;
  kind?: string;
  subjectType?: string;
  subjectKey?: string;
  text?: string;
  confidence?: number;
  occurredAt?: string;
  payload?: JsonRecord;
};

type MemoryContextPack = {
  profile?: JsonRecord;
  residentMemories?: MemoryEntry[];
  relevantMemories?: MemoryEntry[];
  recentEvents?: MemoryEvent[];
};

type DebugPayload = {
  profile?: JsonRecord;
  contextPack?: MemoryContextPack;
  entries?: MemoryEntry[];
  events?: MemoryEvent[];
  latestDreamRun?: JsonRecord;
  dreamRuns?: JsonRecord[];
  generatedCards?: JsonRecord[];
  feedbackEvents?: JsonRecord[];
  connectorRawItems?: JsonRecord[];
  connectorRawSources?: JsonRecord;
  latestDreamRawInputs?: JsonRecord;
};

type PinEnvelope<T> = {
  ok?: boolean;
  data?: T;
};

type InspectorTarget = {
  title: string;
  subtitle: string;
  payload: unknown;
};

type MemoryHit<T> = {
  id: string;
  item: T;
  label: string;
  subtitle: string;
  matchedTerms: string[];
};

type ConnectorTimelineItem = {
  id: string;
  title: string;
  subtitle: string;
  timestamp?: string | null;
  payload: unknown;
};

const SAMPLE_PAYLOAD: DebugPayload = {
  profile: {
    id: "default",
    displayName: "Smile",
    summary: "Builder focused on proactive AI and execution systems.",
    timezone: "Asia/Shanghai",
    goals: [{ key: "career-growth", title: "Grow proactive AI into daily-use assistant" }],
    facts: {
      dreaming: {
        lastRunAt: "2026-04-10T10:13:30.422Z",
        lastSummaryKind: "updated",
        lastCandidateCount: 2,
        latestHighlights: [
          "Pending GitHub PAT review needs admin attention",
          "Composio authorization expanded across GitHub and Supabase",
        ],
      },
    },
    preferences: {
      responseStyle: "concise",
      language: "zh-CN",
    },
    constraints: {
      lowSignalNotifications: "avoid",
    },
    interests: [
      { kind: "topic", key: "supabase", score: 0.88 },
      { kind: "topic", key: "agent-memory", score: 0.94 },
    ],
    snapshots: [
      {
        view: "dreaming",
        generatedAt: "2026-04-10T10:13:30.422Z",
        summary: "Two threads worth attention in GitHub admin and Composio authorization.",
      },
    ],
  },
  contextPack: {
    profile: {
      id: "default",
      displayName: "Smile",
      summary: "Builder focused on proactive AI and execution systems.",
      timezone: "Asia/Shanghai",
      goals: [{ key: "career-growth", title: "Grow proactive AI into daily-use assistant" }],
      preferences: {
        responseStyle: "concise",
        language: "zh-CN",
      },
      constraints: {
        lowSignalNotifications: "avoid",
      },
      interests: [
        { kind: "topic", key: "supabase", score: 0.88 },
        { kind: "topic", key: "agent-memory", score: 0.94 },
      ],
    },
    residentMemories: [
      {
        id: "mem_chat_1",
        category: "conversation",
        text: "User is handling Supabase issue triage this week.",
        status: "active",
        score: 1.2,
        evidenceCount: 2,
        metadata: { subjectType: "conversation", subjectKey: "chat" },
        lastConfirmedAt: "2026-04-10T11:56:59.410Z",
      },
      {
        id: "mem_pref_1",
        category: "preference",
        text: "User prefers concise, execution-ready technical recommendations.",
        status: "active",
        score: 1.5,
        evidenceCount: 3,
        metadata: { sourceKinds: ["user_said", "user_confirmed"] },
        lastConfirmedAt: "2026-04-10T09:10:00.000Z",
      },
    ],
    relevantMemories: [
      {
        id: "mem_chat_1",
        category: "conversation",
        text: "User is handling Supabase issue triage this week.",
        status: "active",
        score: 1.2,
        evidenceCount: 2,
      },
    ],
    recentEvents: [
      {
        id: "mev_chat_1",
        source: "chat",
        kind: "user_said",
        subjectType: "conversation",
        subjectKey: "chat",
        text: "User is handling Supabase issue triage this week.",
        confidence: 0.95,
        occurredAt: "2026-04-10T11:56:59.410Z",
        payload: { sessionKey: "agent:main:chat:abc" },
      },
      {
        id: "mev_feedback_1",
        source: "feedback",
        kind: "user_confirmed",
        subjectType: "intent",
        subjectKey: "repo-maintenance",
        text: "User confirmed a repo maintenance recommendation.",
        confidence: 1,
        occurredAt: "2026-04-10T11:57:10.410Z",
      },
    ],
  },
  entries: [
    {
      id: "mem_chat_1",
      category: "conversation",
      text: "User is handling Supabase issue triage this week.",
      status: "active",
      score: 1.2,
      evidenceCount: 2,
      metadata: { subjectKey: "chat", sourceKinds: ["user_said"] },
    },
    {
      id: "mem_dream_1",
      category: "dreaming",
      text: "Concrete work follow-up",
      status: "active",
      score: 1,
      evidenceCount: 1,
      metadata: { subjectKey: "highlight:concrete-work-follow-up", sourceKinds: ["highlight_captured"] },
    },
  ],
  events: [
    {
      id: "mev_chat_1",
      source: "chat",
      kind: "user_said",
      subjectType: "conversation",
      subjectKey: "chat",
      text: "User is handling Supabase issue triage this week.",
      confidence: 0.95,
      occurredAt: "2026-04-10T11:56:59.410Z",
    },
    {
      id: "mev_dream_1",
      source: "dreaming",
      kind: "highlight_captured",
      subjectType: "dreaming",
      subjectKey: "highlight:concrete-work-follow-up",
      text: "Concrete work follow-up",
      confidence: 0.78,
      occurredAt: "2026-04-10T12:12:00.000Z",
    },
  ],
  latestDreamRun: {
    id: "dream_latest",
    trigger: "manual",
    status: "completed",
    completedAt: "2026-04-10T12:12:00.000Z",
    summaryJson: {
      kind: "updated",
      text: "最近一次 Dreaming 聚焦在 Supabase issue triage 和产品执行优先级。",
      candidateCount: 2,
      highlights: ["Supabase issue triage", "产品执行优先级"],
    },
    profileDeltaJson: {
      interests: {
        after: [{ key: "supabase", score: 0.9 }],
      },
      snapshots: {
        after: [{ view: "dreaming", generatedAt: "2026-04-10T12:12:00.000Z" }],
      },
    },
    goalDeltaJson: {
      changes: [],
    },
    sourceStatsJson: {
      personal: { status: "ok", count: 12 },
      feedback: { status: "ok", count: 2 },
    },
  },
  dreamRuns: [
    {
      id: "dream_latest",
      trigger: "manual",
      status: "completed",
      completedAt: "2026-04-10T12:12:00.000Z",
      summaryJson: {
        kind: "updated",
        text: "最近一次 Dreaming 聚焦在 Supabase issue triage 和产品执行优先级。",
        candidateCount: 2,
      },
    },
    {
      id: "dream_prev",
      trigger: "manual",
      status: "completed",
      completedAt: "2026-04-10T10:12:00.000Z",
      summaryJson: {
        kind: "updated",
        text: "上一轮 Dreaming 识别到 GitHub PAT 审批和 Composio 授权扩展。",
        candidateCount: 3,
      },
    },
  ],
  generatedCards: [
    {
      id: "card_2_1",
      runId: "run_auto_mnsc7gms",
      completedAt: "2026-04-10T03:23:26.304Z",
      goalBasket: "wealth",
      title: "3 key signals from the FOMC March minutes vs. Zandi's three-cut forecast",
      summary: "提炼 FOMC minutes 和 Zandi forecast 的差异，辅助周五前做判断。",
      confidence: 0.78,
      overallScore: 7.5,
      pass: true,
    },
  ],
  feedbackEvents: [
    {
      id: "fe_6io0ls5l",
      intentCardId: "card_2_1",
      kind: "card_open",
      source: "user_direct",
      basket: "wealth",
      channel: "web",
      createdAt: "2026-04-10T08:13:16.393Z",
      metadata: {
        runId: "run_auto_mnsc7gms",
        surface: "now_feed",
      },
    },
  ],
  connectorRawItems: [
    {
      connector: "gmail",
      status: "ok",
      itemCount: 8,
      toolRunCount: 1,
      reason: null,
    },
  ],
  connectorRawSources: {
    gmail: {
      status: "ok",
      itemCount: 8,
    },
  },
  latestDreamRawInputs: {
    personal: {
      connectors: {
        gmail: {
          status: "ok",
          itemCount: 8,
        },
      },
    },
    signals: [],
    feedback: [],
    cards: [],
  },
};

const sampleJson = JSON.stringify(SAMPLE_PAYLOAD, null, 2);
const sampleEnvelopeContext = JSON.stringify({ ok: true, data: SAMPLE_PAYLOAD.contextPack }, null, 2);
const sampleEnvelopeEntries = JSON.stringify({ ok: true, data: SAMPLE_PAYLOAD.entries }, null, 2);
const sampleEnvelopeEvents = JSON.stringify({ ok: true, data: SAMPLE_PAYLOAD.events }, null, 2);
const REAL_DATA_URL = "/real-memory.json";
const EXAMPLE_TOPICS = ["AI新闻", "比特币", "Supabase issue", "GitHub PAT"];

function parseJsonSafe<T>(value: string): { data: T | null; error: string | null } {
  try {
    return { data: JSON.parse(value) as T, error: null };
  } catch (error) {
    return { data: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function unwrapEnvelopeData<T>(value: string): { data: T | null; error: string | null } {
  const parsed = parseJsonSafe<PinEnvelope<T> | T>(value);
  if (parsed.error || !parsed.data) {
    return { data: null, error: parsed.error };
  }

  const record = parsed.data as PinEnvelope<T> | T;
  if (record && typeof record === "object" && "data" in (record as PinEnvelope<T>)) {
    return { data: ((record as PinEnvelope<T>).data ?? null) as T | null, error: null };
  }

  return { data: record as T, error: null };
}

function readArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function readObject(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function stringifyValue(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function flattenKeyValues(record: JsonRecord): Array<{ key: string; value: unknown }> {
  return Object.entries(record).map(([key, value]) => ({ key, value }));
}

function summarizeSourceStats(value: JsonRecord): Array<{ key: string; status: string; count: number; reason?: string }> {
  return Object.entries(value).map(([key, raw]) => {
    const record = readObject(raw);
    return {
      key,
      status: typeof record.status === "string" ? record.status : "unknown",
      count: typeof record.count === "number" ? record.count : 0,
      reason: typeof record.message === "string" ? record.message : typeof record.reason === "string" ? record.reason : undefined,
    };
  });
}

function countArrayField(value: unknown, field: string): number {
  return readArray(readObject(value)[field]).length;
}

function mergeJsonValue(primary: unknown, fallback: unknown): unknown {
  if (Array.isArray(primary) || Array.isArray(fallback)) {
    if (Array.isArray(primary) && primary.length > 0) return primary;
    if (Array.isArray(fallback)) return fallback;
    return [];
  }

  if (
    primary &&
    typeof primary === "object" &&
    !Array.isArray(primary) &&
    fallback &&
    typeof fallback === "object" &&
    !Array.isArray(fallback)
  ) {
    const primaryRecord = primary as Record<string, unknown>;
    const fallbackRecord = fallback as Record<string, unknown>;
    const keys = new Set([...Object.keys(fallbackRecord), ...Object.keys(primaryRecord)]);
    const merged: Record<string, unknown> = {};

    for (const key of keys) {
      merged[key] = mergeJsonValue(primaryRecord[key], fallbackRecord[key]);
    }

    return merged;
  }

  if (primary == null || primary === "") {
    return fallback ?? primary;
  }

  return primary;
}

function mergeRecords(primary: JsonRecord, fallback: JsonRecord): JsonRecord {
  return readObject(mergeJsonValue(primary, fallback));
}

function formatDate(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function extractLatestSnapshot(profile: JsonRecord): JsonRecord | null {
  const snapshots = readArray<JsonRecord>(profile.snapshots);
  if (snapshots.length === 0) return null;
  return snapshots[snapshots.length - 1] ?? null;
}

function tokenizeQuery(query: string): string[] {
  return Array.from(
    new Set(
      query
        .split(/[\s,./:;|()[\]{}"']+/)
        .map((item) => item.trim().toLowerCase())
        .filter((item) => item.length >= 2),
    ),
  );
}

function buildMemoryHits<T>(items: T[], terms: string[], labelFor: (item: T) => string, subtitleFor: (item: T) => string): MemoryHit<T>[] {
  if (terms.length === 0) return [];

  return items
    .map((item, index) => {
      const haystack = JSON.stringify(item).toLowerCase();
      const matchedTerms = terms.filter((term) => haystack.includes(term));
      return {
        id: `${index}-${labelFor(item)}`,
        item,
        label: labelFor(item),
        subtitle: subtitleFor(item),
        matchedTerms,
      };
    })
    .filter((item) => item.matchedTerms.length > 0)
    .sort((left, right) => right.matchedTerms.length - left.matchedTerms.length || left.label.localeCompare(right.label));
}

function buildInitialInspector(payload: DebugPayload): InspectorTarget {
  return {
    title: "当前载入数据",
    subtitle: "画像与记忆的全量载荷",
    payload,
  };
}

function translateCategory(value?: string): string {
  const mapping: Record<string, string> = {
    conversation: "对话",
    preference: "偏好",
    constraint: "约束",
    interest: "兴趣",
    fact: "事实",
    routine: "习惯",
    relationship: "关系",
    dreaming: "后台归纳",
  };
  return value ? (mapping[value] ?? value) : "未分类";
}

function translateStatus(value?: string): string {
  const mapping: Record<string, string> = {
    active: "生效中",
    suppressed: "已压制",
  };
  return value ? (mapping[value] ?? value) : "未知";
}

function translateSource(value?: string): string {
  const mapping: Record<string, string> = {
    chat: "对话",
    feedback: "反馈",
    dreaming: "后台归纳",
    card_action: "卡片操作",
    tool_observed: "工具观察",
  };
  return value ? (mapping[value] ?? value) : "未知来源";
}

function translateKind(value?: string): string {
  const mapping: Record<string, string> = {
    user_said: "用户说过",
    user_confirmed: "用户确认",
    user_clicked: "用户点击",
    user_dismissed: "用户忽略",
    highlight_captured: "高亮归档",
    tool_observed: "工具观察",
  };
  return value ? (mapping[value] ?? value) : "未知类型";
}

function translateRunStatus(value?: string): string {
  const mapping: Record<string, string> = {
    completed: "已完成",
    failed: "失败",
    running: "运行中",
  };
  return value ? (mapping[value] ?? value) : "未知状态";
}

function translateTrigger(value?: string): string {
  const mapping: Record<string, string> = {
    manual: "手动",
    scheduled: "定时",
    auto: "自动",
  };
  return value ? (mapping[value] ?? value) : "未知触发";
}

function translateBasket(value?: string): string {
  const mapping: Record<string, string> = {
    work: "工作",
    wealth: "财富",
    life: "生活",
    health: "健康",
    growth: "成长",
  };
  return value ? (mapping[value] ?? value) : "未分类";
}

function translateFeedbackKind(value?: string): string {
  const mapping: Record<string, string> = {
    card_open: "打开卡片",
    card_confirm: "确认卡片",
    card_modify: "修改卡片",
    card_dismiss: "忽略卡片",
    card_snooze: "稍后提醒",
  };
  return value ? (mapping[value] ?? value) : "卡片反馈";
}

function translateConnector(value?: string): string {
  const mapping: Record<string, string> = {
    gmail: "Gmail",
    googledrive: "Google Drive",
    googlecalendar: "Google Calendar",
    slack: "Slack",
    github: "GitHub",
    notion: "Notion",
  };
  return value ? (mapping[value] ?? value) : "未知连接器";
}

function extractConnectorTimelineItems(item: JsonRecord): ConnectorTimelineItem[] {
  const connector = stringifyValue(item.connector ?? "connector");
  const toolRuns = readArray<JsonRecord>(item.toolRuns);
  const rows: ConnectorTimelineItem[] = [];

  toolRuns.forEach((run, runIndex) => {
    const payload = readObject(run.payload);
    const data = readObject(payload.data);
    const files = readArray<JsonRecord>(data.files);
    const messages = readArray<JsonRecord>(data.messages);
    const slackItems = readArray<JsonRecord>(data.items);
    const calendarSettings = readArray<JsonRecord>(data.items);
    const calendarEvents = readArray<JsonRecord>(readObject(data.event_data).event_data);

    if (files.length > 0) {
      files.forEach((file, fileIndex) => {
        rows.push({
          id: `${connector}-file-${runIndex}-${fileIndex}`,
          title: stringifyValue(file.name ?? file.title ?? file.id ?? "文件"),
          subtitle: `${translateConnector(item.connector as string | undefined)} · 文件`,
          timestamp: (file.modifiedTime as string | undefined) ?? (file.createdTime as string | undefined) ?? null,
          payload: file,
        });
      });
      return;
    }

    if (messages.length > 0) {
      messages.forEach((message, messageIndex) => {
        const preview = readObject(message.preview);
        rows.push({
          id: `${connector}-message-${runIndex}-${messageIndex}`,
          title: stringifyValue(message.subject ?? preview.subject ?? message.messageId ?? "邮件"),
          subtitle: `${translateConnector(item.connector as string | undefined)} · 邮件`,
          timestamp: (message.messageTimestamp as string | undefined) ?? null,
          payload: message,
        });
      });
      return;
    }

    if (calendarEvents.length > 0) {
      calendarEvents.forEach((event, eventIndex) => {
        rows.push({
          id: `${connector}-calendar-event-${runIndex}-${eventIndex}`,
          title: stringifyValue(event.summary ?? event.id ?? "日历事件"),
          subtitle: `${translateConnector(item.connector as string | undefined)} · 日历事件`,
          timestamp:
            (readObject(event.start).dateTime as string | undefined) ??
            (readObject(event.start).date as string | undefined) ??
            (event.updated as string | undefined) ??
            null,
          payload: event,
        });
      });
      return;
    }

    if (item.connector === "slack" && slackItems.length > 0) {
      slackItems.forEach((slackItem, slackIndex) => {
        const message = readObject(slackItem.message);
        rows.push({
          id: `${connector}-slack-message-${runIndex}-${slackIndex}`,
          title: stringifyValue(message.text ?? message.permalink ?? slackItem.channel ?? "Slack 消息"),
          subtitle: `${translateConnector(item.connector as string | undefined)} · Slack 消息`,
          timestamp: (message.ts as string | undefined) ?? null,
          payload: slackItem,
        });
      });
      return;
    }

    if (item.connector === "googlecalendar" && calendarSettings.length > 0) {
      calendarSettings.forEach((setting, settingIndex) => {
        rows.push({
          id: `${connector}-calendar-setting-${runIndex}-${settingIndex}`,
          title: stringifyValue(setting.summary ?? setting.id ?? setting.name ?? "日历配置"),
          subtitle: `${translateConnector(item.connector as string | undefined)} · 配置项`,
          timestamp: null,
          payload: setting,
        });
      });
      return;
    }

    rows.push({
      id: `${connector}-toolrun-${runIndex}`,
      title: stringifyValue(run.slug ?? run.description ?? "工具调用"),
      subtitle: `${translateConnector(item.connector as string | undefined)} · 工具调用`,
      timestamp: null,
      payload: run,
    });
  });

  return rows;
}

function Panel(props: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <section className="panel">
      <div className="panelHeader">
        <h2>{props.title}</h2>
        <p>{props.hint}</p>
      </div>
      {props.children}
    </section>
  );
}

function StorageCard(props: { title: string; subtitle: string; value: string | number; onClick: () => void; active?: boolean }) {
  return (
    <button type="button" className={`storageCard${props.active ? " active" : ""}`} onClick={props.onClick}>
      <span>{props.title}</span>
      <strong>{props.value}</strong>
      <small>{props.subtitle}</small>
    </button>
  );
}

function KeyValueChips(props: {
  title: string;
  items: Array<{ key: string; value: unknown }>;
  onClick: (payload: InspectorTarget) => void;
  className?: string;
}) {
  return (
    <div className={`stateBlock ${props.className ?? ""}`.trim()}>
      <div className="stateBlockHeader">
        <h3>{props.title}</h3>
      </div>
      {props.items.length === 0 ? (
        <p className="emptyState">暂无数据</p>
      ) : (
        <div className="chipWrap">
          {props.items.map((item) => (
            <button
              key={`${props.title}-${item.key}`}
              type="button"
              className="chipButton"
              onClick={() =>
                props.onClick({
                  title: `${props.title} / ${item.key}`,
                  subtitle: "画像字段",
                  payload: item,
                })
              }
            >
              {item.key}: {stringifyValue(item.value)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function MemoryRow(props: { entry: MemoryEntry; subtitle: string; onClick: (payload: InspectorTarget) => void }) {
  return (
    <button
      type="button"
      className="memoryRow"
      onClick={() =>
        props.onClick({
          title: props.entry.text ?? "记忆结论",
          subtitle: props.subtitle,
          payload: props.entry,
        })
      }
    >
      <div className="memoryRowTop">
        <div className="eventBadges">
          <span className="pill">{translateCategory(props.entry.category)}</span>
          <span className="pill muted">{translateStatus(props.entry.status)}</span>
        </div>
        <span className="timePill">{formatDate(props.entry.lastConfirmedAt)}</span>
      </div>
      <strong>{props.entry.text ?? "暂无文本"}</strong>
      <small>分数 {props.entry.score?.toFixed(2) ?? "—"} · 证据数 {props.entry.evidenceCount ?? "—"} · {props.subtitle}</small>
    </button>
  );
}

function EventRow(props: { event: MemoryEvent; subtitle: string; onClick: (payload: InspectorTarget) => void }) {
  return (
    <button
      type="button"
      className="eventRow"
      onClick={() =>
        props.onClick({
          title: props.event.text ?? "记忆线索",
          subtitle: props.subtitle,
          payload: props.event,
        })
      }
    >
      <div className="eventBadges">
        <div className="eventBadges">
          <span className="pill accent">{translateSource(props.event.source)}</span>
          <span className="pill">{translateKind(props.event.kind)}</span>
        </div>
        <span className="timePill">{formatDate(props.event.occurredAt)}</span>
      </div>
      <strong>{props.event.text ?? "暂无文本"}</strong>
      <small>{props.event.subjectKey ?? "未知主题"} · 置信度 {typeof props.event.confidence === "number" ? props.event.confidence.toFixed(2) : "—"}</small>
    </button>
  );
}

function DreamRunRow(props: { run: JsonRecord; onClick: (payload: InspectorTarget) => void }) {
  const summary = readObject(props.run.summaryJson);
  const highlightCount = readArray(summary.highlights).length;
  const highlights = readArray<string>(summary.highlights).slice(0, 3);
  return (
    <button
      type="button"
      className="eventRow dreamRow"
      onClick={() =>
        props.onClick({
          title: stringifyValue(props.run.id ?? "dream run"),
          subtitle: "Dreaming 运行详情",
          payload: props.run,
        })
      }
    >
      <div className="memoryRowTop">
        <div className="eventBadges">
          <span className="pill accent">Dream Run</span>
          <span className="pill">{translateTrigger(props.run.trigger as string | undefined)}</span>
          <span className="pill muted">{translateRunStatus(props.run.status as string | undefined)}</span>
        </div>
        <span className="timePill">{formatDate((props.run.completedAt as string | undefined) ?? null)}</span>
      </div>
      <strong>{stringifyValue(summary.text ?? props.run.id ?? "Dreaming 运行")}</strong>
      <small>候选 {stringifyValue(summary.candidateCount ?? "—")} · 高亮 {highlightCount} · run {stringifyValue(props.run.id ?? "—")}</small>
      {highlights.length > 0 ? (
        <div className="dreamHighlights">
          {highlights.map((item, index) => (
            <span key={`${props.run.id ?? "dream"}-${index}`} className="chipTag">
              {item}
            </span>
          ))}
        </div>
      ) : null}
    </button>
  );
}

function GeneratedCardRow(props: { card: JsonRecord; onClick: (payload: InspectorTarget) => void }) {
  return (
    <button
      type="button"
      className="memoryRow"
      onClick={() =>
        props.onClick({
          title: stringifyValue(props.card.title ?? props.card.id ?? "生成卡片"),
          subtitle: "最近生成卡片",
          payload: props.card,
        })
      }
    >
      <div className="memoryRowTop">
        <div className="eventBadges">
          <span className="pill accent">{translateBasket(props.card.goalBasket as string | undefined)}</span>
          <span className="pill muted">{props.card.pass === true ? "通过" : props.card.pass === false ? "未过" : "未评分"}</span>
        </div>
        <span className="timePill">{formatDate(props.card.completedAt as string | undefined)}</span>
      </div>
      <strong>{stringifyValue(props.card.title ?? "无标题卡片")}</strong>
      <small>置信度 {typeof props.card.confidence === "number" ? (props.card.confidence as number).toFixed(2) : "—"} · 评分 {typeof props.card.overallScore === "number" ? (props.card.overallScore as number).toFixed(1) : "—"}</small>
    </button>
  );
}

function FeedbackRow(props: { item: JsonRecord; cardTitle?: string; onClick: (payload: InspectorTarget) => void }) {
  const actionTitle = translateFeedbackKind(props.item.kind as string | undefined);
  const cardTitle = props.cardTitle ?? stringifyValue(props.item.intentCardId ?? "未知卡片");
  return (
    <button
      type="button"
      className="eventRow"
      onClick={() =>
        props.onClick({
          title: actionTitle,
          subtitle: "用户对卡片的反馈/打开记录",
          payload: props.item,
        })
      }
    >
      <div className="memoryRowTop">
        <div className="eventBadges">
          <span className="pill accent">{actionTitle}</span>
          <span className="pill">{translateBasket(props.item.basket as string | undefined)}</span>
        </div>
        <span className="timePill">{formatDate(props.item.createdAt as string | undefined)}</span>
      </div>
      <strong>{cardTitle}</strong>
      <small>
        {stringifyValue(props.item.source ?? "未知来源")} · {stringifyValue(props.item.channel ?? "未知渠道")} ·{" "}
        {stringifyValue(props.item.intentCardId ?? "无卡片 ID")}
      </small>
    </button>
  );
}

function ConnectorRawRow(props: { item: JsonRecord; onClick: (payload: InspectorTarget) => void }) {
  return (
    <button
      type="button"
      className="eventRow"
      onClick={() =>
        props.onClick({
          title: stringifyValue(props.item.connector ?? "connector"),
          subtitle: "最新 Dreaming 的 connector raw 输入",
          payload: props.item,
        })
      }
    >
      <div className="eventBadges">
        <span className="pill accent">{stringifyValue(props.item.connector ?? "未知连接")}</span>
        <span className="pill">{stringifyValue(props.item.status ?? "未知状态")}</span>
      </div>
      <strong>{stringifyValue(props.item.connector ?? "未知连接")}</strong>
      <small>
        原始项 {stringifyValue(props.item.itemCount ?? 0)} · 工具调用 {stringifyValue(props.item.toolRunCount ?? 0)} ·{" "}
        {stringifyValue(props.item.reason ?? "无错误信息")}
      </small>
    </button>
  );
}

function HitList<T>(props: {
  title: string;
  hits: MemoryHit<T>[];
  empty: string;
  onClick: (hit: MemoryHit<T>) => void;
}) {
  return (
    <div className="stateBlock">
      <div className="stateBlockHeader">
        <h3>{props.title}</h3>
        <span>{props.hits.length}</span>
      </div>
      {props.hits.length === 0 ? (
        <p className="emptyState">{props.empty}</p>
      ) : (
        <div className="hitList">
          {props.hits.map((hit) => (
            <button key={hit.id} type="button" className="hitRow" onClick={() => props.onClick(hit)}>
              <strong>{hit.label}</strong>
              <small>{hit.subtitle}</small>
              <div className="chipWrap">
                {hit.matchedTerms.map((term) => (
                  <span key={`${hit.id}-${term}`} className="chipTag">
                    {term}
                  </span>
                ))}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function JsonTreeNode(props: { name?: string; value: unknown; level?: number }) {
  const level = props.level ?? 0;

  if (Array.isArray(props.value)) {
    return (
      <details className="jsonTreeNode" open={level < 1}>
        <summary>
          {props.name ? <span className="jsonTreeKey">{props.name}</span> : null}
          <span className="jsonTreeMeta">数组[{props.value.length}]</span>
        </summary>
        <div className="jsonTreeChildren">
          {props.value.length === 0 ? <div className="jsonTreeLeaf empty">空数组</div> : null}
          {props.value.map((item, index) => (
            <JsonTreeNode key={`${props.name ?? "root"}-${index}`} name={`[${index}]`} value={item} level={level + 1} />
          ))}
        </div>
      </details>
    );
  }

  if (props.value && typeof props.value === "object") {
    const entries = Object.entries(props.value as Record<string, unknown>);
    return (
      <details className="jsonTreeNode" open={level < 1}>
        <summary>
          {props.name ? <span className="jsonTreeKey">{props.name}</span> : null}
          <span className="jsonTreeMeta">对象{`{${entries.length}}`}</span>
        </summary>
        <div className="jsonTreeChildren">
          {entries.length === 0 ? <div className="jsonTreeLeaf empty">空对象</div> : null}
          {entries.map(([key, value]) => (
            <JsonTreeNode key={`${props.name ?? "root"}-${key}`} name={key} value={value} level={level + 1} />
          ))}
        </div>
      </details>
    );
  }

  return (
    <div className="jsonTreeLeaf">
      {props.name ? <span className="jsonTreeKey">{props.name}</span> : null}
      <span className={`jsonTreeValue ${props.value == null ? "nullish" : typeof props.value}`}>
        {typeof props.value === "string" ? `"${props.value}"` : stringifyValue(props.value)}
      </span>
    </div>
  );
}

function JsonExplorer(props: { value: unknown }) {
  return (
    <div className="jsonExplorer">
      <JsonTreeNode value={props.value} />
    </div>
  );
}

export function App() {
  const [jsonText, setJsonText] = useState(sampleJson);
  const [query, setQuery] = useState("Supabase issue");
  const [realDataStatus, setRealDataStatus] = useState<"idle" | "loading" | "ready" | "missing" | "error">("idle");
  const [contextText, setContextText] = useState(sampleEnvelopeContext);
  const [entriesText, setEntriesText] = useState(sampleEnvelopeEntries);
  const [eventsText, setEventsText] = useState(sampleEnvelopeEvents);
  const [inspector, setInspector] = useState<InspectorTarget>(() => buildInitialInspector(SAMPLE_PAYLOAD));
  const [inspectorMode, setInspectorMode] = useState<"tree" | "raw">("tree");
  const [activeOverview, setActiveOverview] = useState<
    "profile" | "entries" | "events" | "dreaming" | "cards" | "feedback" | "connectors"
  >("profile");
  const [activeConnector, setActiveConnector] = useState<string | null>(null);

  const parsed = useMemo(() => parseJsonSafe<DebugPayload>(jsonText), [jsonText]);
  const payload = parsed.data ?? SAMPLE_PAYLOAD;

  const parsedContextEnvelope = useMemo(() => unwrapEnvelopeData<MemoryContextPack>(contextText), [contextText]);
  const parsedEntriesEnvelope = useMemo(() => unwrapEnvelopeData<MemoryEntry[]>(entriesText), [entriesText]);
  const parsedEventsEnvelope = useMemo(() => unwrapEnvelopeData<MemoryEvent[]>(eventsText), [eventsText]);

  const profile = readObject(payload.profile);
  const contextProfile = readObject(payload.contextPack?.profile);
  const effectiveProfile = mergeRecords(profile, contextProfile);
  const residentMemories = readArray<MemoryEntry>(payload.contextPack?.residentMemories);
  const relevantMemories = readArray<MemoryEntry>(payload.contextPack?.relevantMemories);
  const recentEvents = readArray<MemoryEvent>(payload.contextPack?.recentEvents);
  const allEntries = readArray<MemoryEntry>(payload.entries);
  const allEvents = readArray<MemoryEvent>(payload.events);
  const latestDreamRun = readObject(payload.latestDreamRun);
  const dreamRuns = readArray<JsonRecord>(payload.dreamRuns);
  const generatedCards = readArray<JsonRecord>(payload.generatedCards);
  const feedbackEvents = readArray<JsonRecord>(payload.feedbackEvents);
  const connectorRawItems = readArray<JsonRecord>(payload.connectorRawItems);
  const connectorRawSources = readObject(payload.connectorRawSources);
  const latestDreamRawInputs = readObject(payload.latestDreamRawInputs);
  const generatedCardTitleById = useMemo(
    () =>
      generatedCards.reduce<Record<string, string>>((accumulator, card) => {
        const id = typeof card.id === "string" ? card.id : null;
        if (id) accumulator[id] = stringifyValue(card.title ?? id);
        return accumulator;
      }, {}),
    [generatedCards],
  );
  const displayedDreamRuns =
    dreamRuns.length > 0
      ? dreamRuns
      : Object.keys(latestDreamRun).length > 0
        ? [latestDreamRun]
        : [];
  const connectorGroups = useMemo(
    () =>
      connectorRawItems.reduce<Record<string, JsonRecord>>((accumulator, item) => {
        const key = typeof item.connector === "string" ? item.connector : "unknown";
        accumulator[key] = item;
        return accumulator;
      }, {}),
    [connectorRawItems],
  );
  const connectorKeys = Object.keys(connectorGroups);
  const selectedConnectorKey =
    activeConnector && connectorGroups[activeConnector] ? activeConnector : connectorKeys[0] ?? null;
  const selectedConnector = selectedConnectorKey ? connectorGroups[selectedConnectorKey] : null;
  const selectedConnectorTimeline = useMemo(
    () => (selectedConnector ? extractConnectorTimelineItems(selectedConnector) : []),
    [selectedConnector],
  );

  const goals = readArray<JsonRecord>(effectiveProfile.goals);
  const interests = readArray<JsonRecord>(effectiveProfile.interests);
  const preferenceItems = flattenKeyValues(readObject(effectiveProfile.preferences));
  const constraintItems = flattenKeyValues(readObject(effectiveProfile.constraints));
  const dreamingFacts = readObject(readObject(effectiveProfile.facts).dreaming);
  const latestSnapshot = extractLatestSnapshot(effectiveProfile);
  const dreamRunSummary = readObject(latestDreamRun.summaryJson);
  const dreamRunProfileDelta = readObject(latestDreamRun.profileDeltaJson);
  const dreamRunGoalDelta = readObject(latestDreamRun.goalDeltaJson);
  const dreamRunSourceStats = readObject(latestDreamRun.sourceStatsJson);
  const dreamingSourceStats = readObject(
    dreamingFacts.sourceStats ?? readObject(latestSnapshot).sourceStats ?? dreamRunSourceStats,
  );
  const sourceStatsItems = summarizeSourceStats(dreamingSourceStats);
  const snapshotHighlights = readArray<string>(readObject(latestSnapshot).highlights);
  const dreamingHighlights = readArray<string>(dreamingFacts.latestHighlights);
  const dreamingHighlightCount = dreamingHighlights.length > 0 ? dreamingHighlights.length : snapshotHighlights.length;
  const dreamingCandidateCount =
    typeof dreamingFacts.lastCandidateCount === "number"
      ? dreamingFacts.lastCandidateCount
      : typeof readObject(latestSnapshot).candidateCount === "number"
        ? (readObject(latestSnapshot).candidateCount as number)
        : 0;
  const profileDeltaInterestCount = countArrayField(dreamRunProfileDelta, "interests");
  const profileDeltaSnapshotCount = countArrayField(dreamRunProfileDelta, "snapshots");
  const goalDeltaChangeCount = countArrayField(dreamRunGoalDelta, "changes");
  const queryTerms = useMemo(() => tokenizeQuery(query), [query]);

  const residentHits = useMemo(
    () =>
      buildMemoryHits(
        residentMemories,
        queryTerms,
        (entry) => entry.text ?? "常驻记忆",
        (entry) => `${entry.category ?? "unknown"} / 常驻层`,
      ),
    [residentMemories, queryTerms],
  );

  const entryHits = useMemo(
    () =>
      buildMemoryHits(
        allEntries,
        queryTerms,
        (entry) => entry.text ?? "记忆结论",
        (entry) => `${entry.category ?? "unknown"} / 记忆结论层`,
      ),
    [allEntries, queryTerms],
  );

  const eventHits = useMemo(
    () =>
      buildMemoryHits(
        allEvents,
        queryTerms,
        (event) => event.text ?? "记忆线索",
        (event) => `${event.source ?? "unknown"} / ${event.kind ?? "unknown"}`,
      ),
    [allEvents, queryTerms],
  );

  const simulatedContextPack = useMemo(
    () => ({
      profile: {
        displayName: effectiveProfile.displayName,
        summary: effectiveProfile.summary,
        timezone: effectiveProfile.timezone,
        goals,
        preferences: effectiveProfile.preferences,
        constraints: effectiveProfile.constraints,
        interests: interests.slice(0, 6),
      },
      residentMemories: residentMemories.slice(0, 6),
      relevantMemories: entryHits.slice(0, 6).map((hit) => hit.item),
      recentEvents: eventHits.slice(0, 6).map((hit) => hit.item),
      query,
      queryTerms,
    }),
    [effectiveProfile, goals, interests, residentMemories, entryHits, eventHits, query, queryTerms],
  );

  const coverageItems = useMemo(
    () => [
      { label: "profiles", present: Object.keys(profile).length > 0, note: "基础画像表" },
      { label: "contextPack.profile", present: Object.keys(contextProfile).length > 0, note: "生成时真正注入的画像" },
      { label: "memory_entries", present: allEntries.length > 0, note: "记忆结论池" },
      { label: "memory_events", present: allEvents.length > 0, note: "记忆线索池" },
      { label: "generatedCards", present: generatedCards.length > 0, note: "最近生成过的卡片" },
      { label: "feedbackEvents", present: feedbackEvents.length > 0, note: "用户对卡片的反馈/打开记录" },
      { label: "connectorRawItems", present: connectorRawItems.length > 0, note: "最新 Dreaming 的 connector 原始输入" },
      { label: "facts.dreaming", present: Object.keys(dreamingFacts).length > 0, note: "后台归纳摘要" },
      { label: "profile.snapshots", present: latestSnapshot !== null, note: "画像快照" },
      { label: "sourceStats", present: sourceStatsItems.length > 0, note: "来源/连接概况" },
      { label: "latestDreamRun", present: Object.keys(latestDreamRun).length > 0, note: "最新一次 dreaming run" },
      { label: "dreamRuns", present: displayedDreamRuns.length > 0, note: "最近 Dreaming 运行列表" },
      { label: "dream_run.profile_delta", present: Object.keys(dreamRunProfileDelta).length > 0, note: "run 级 profile delta" },
      { label: "dream_run.goal_delta", present: Object.keys(dreamRunGoalDelta).length > 0, note: "run 级 goal delta" },
      { label: "connector raw items", present: false, note: "当前 payload 里还没有每个 connector 的原始条目" },
    ],
    [
      profile,
      contextProfile,
      allEntries.length,
      allEvents.length,
      generatedCards.length,
      feedbackEvents.length,
      connectorRawItems.length,
      dreamingFacts,
      latestSnapshot,
      sourceStatsItems.length,
      latestDreamRun,
      dreamRunProfileDelta,
      dreamRunGoalDelta,
      displayedDreamRuns.length,
    ],
  );

  useEffect(() => {
    setInspector(buildInitialInspector(payload));
  }, [jsonText]);

  useEffect(() => {
    if (!selectedConnectorKey) return;
    setActiveConnector(selectedConnectorKey);
  }, [selectedConnectorKey]);

  const loadRealData = async () => {
    setRealDataStatus("loading");
    try {
      const response = await fetch(REAL_DATA_URL, { cache: "no-store" });
      if (!response.ok) {
        setRealDataStatus(response.status === 404 ? "missing" : "error");
        return;
      }
      setJsonText(await response.text());
      setRealDataStatus("ready");
    } catch {
      setRealDataStatus("error");
    }
  };

  useEffect(() => {
    void loadRealData();
  }, []);

  const onFileImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setJsonText(await file.text());
  };

  const assembleFromCommands = () => {
    const nextPayload: DebugPayload = {
      contextPack: parsedContextEnvelope.data ?? undefined,
      entries: parsedEntriesEnvelope.data ?? undefined,
      events: parsedEventsEnvelope.data ?? undefined,
    };
    setJsonText(JSON.stringify(nextPayload, null, 2));
  };

  const activateOverview = (
    next:
      | "profile"
      | "entries"
      | "events"
      | "dreaming"
      | "cards"
      | "feedback"
      | "connectors",
    target: InspectorTarget,
  ) => {
    setActiveOverview(next);
    setInspector(target);
  };

  const renderOverviewPanel = () => {
    switch (activeOverview) {
      case "profile":
        return (
          <div className="overviewPanel">
            <div className="overviewPanelHeader">
              <span className="sectionLabel">用户画像</span>
              <h3>用户画像总览</h3>
              <p>这里只看用户画像本体：Summary、时区、目标、约束、兴趣。技术性字段下沉到系统元数据，不抢首屏。</p>
            </div>
            <div className="overviewHero">
              <strong>{stringifyValue(effectiveProfile.displayName ?? "未知用户")}</strong>
              <p>{stringifyValue(effectiveProfile.summary)}</p>
              <div className="miniStatRow">
                <span>画像 ID {stringifyValue(effectiveProfile.id)}</span>
                <span>时区 {stringifyValue(effectiveProfile.timezone)}</span>
                <span>{goals.length} 个目标</span>
                <span>{interests.length} 条兴趣</span>
              </div>
            </div>
            <div className="overviewGrid">
              <div className="overviewBlock">
                <h4>目标</h4>
                <div className="chipWrap">
                  {goals.length === 0 ? <p className="emptyState">暂无目标</p> : null}
                  {goals.map((goal, index) => (
                    <button
                      key={`overview-goal-${index}`}
                      type="button"
                      className="chipButton accent"
                      onClick={() =>
                        setInspector({
                          title: goal.title ? stringifyValue(goal.title) : `目标 ${index + 1}`,
                          subtitle: "画像目标",
                          payload: goal,
                        })
                      }
                    >
                      {stringifyValue(goal.title ?? goal.key ?? `goal-${index + 1}`)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="overviewBlock">
                <h4>约束</h4>
                <div className="chipWrap">
                  {constraintItems.length === 0 ? <p className="emptyState">暂无约束</p> : null}
                  {constraintItems.map((item) => (
                    <button
                      key={`constraint-${item.key}`}
                      type="button"
                      className="chipButton"
                      onClick={() =>
                        setInspector({
                          title: `约束 / ${item.key}`,
                          subtitle: "画像字段",
                          payload: item,
                        })
                      }
                    >
                      {item.key}: {stringifyValue(item.value)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="overviewBlock">
                <h4>兴趣</h4>
                <div className="chipWrap">
                  {interests.length === 0 ? <p className="emptyState">暂无兴趣</p> : null}
                  {interests.map((interest, index) => (
                    <button
                      key={`overview-interest-${index}`}
                      type="button"
                      className="chipButton accent"
                      onClick={() =>
                        setInspector({
                          title: stringifyValue(interest.key ?? `interest-${index + 1}`),
                          subtitle: "画像兴趣",
                          payload: interest,
                        })
                      }
                    >
                      {stringifyValue(interest.key)} · {typeof interest.score === "number" ? interest.score.toFixed(2) : "—"}
                    </button>
                  ))}
                </div>
              </div>
              <div className="overviewBlock">
                <h4>系统元数据</h4>
                <div className="chipWrap">
                  {preferenceItems.length === 0 && Object.keys(dreamingFacts).length === 0 ? <p className="emptyState">暂无系统元数据</p> : null}
                  {preferenceItems.map((item) => (
                    <button
                      key={`pref-${item.key}`}
                      type="button"
                      className="chipButton"
                      onClick={() =>
                        setInspector({
                          title: `偏好 / ${item.key}`,
                          subtitle: "系统元数据",
                          payload: item,
                        })
                      }
                    >
                      {item.key}: {stringifyValue(item.value)}
                    </button>
                  ))}
                  {Object.keys(dreamingFacts).length > 0 ? (
                    <button
                      type="button"
                      className="chipButton"
                      onClick={() =>
                        setInspector({
                          title: "Dreaming 元数据",
                          subtitle: "画像里的后台归纳字段",
                          payload: dreamingFacts,
                        })
                      }
                    >
                      Dreaming 元数据 · {dreamingFacts.lastUpdatedAt ? formatDate(dreamingFacts.lastUpdatedAt as string) : "可查看"}
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        );
      case "entries":
        return (
          <div className="overviewPanel">
            <div className="overviewPanelHeader">
              <span className="sectionLabel">记忆结论</span>
              <h3>记忆结论时间线</h3>
              <p>这里优先看每条记忆的最近确认时间和内容本身，常驻记忆会混在这层里一起看。</p>
            </div>
            <div className="feedList" aria-label="记忆结论列表">
              {allEntries.map((entry) => (
                <MemoryRow key={entry.id ?? entry.text} entry={entry} subtitle="记忆结论" onClick={setInspector} />
              ))}
            </div>
          </div>
        );
      case "events":
        return (
          <div className="overviewPanel">
            <div className="overviewPanelHeader">
              <span className="sectionLabel">记忆线索</span>
              <h3>记忆线索时间线</h3>
              <p>这一层是原始学习证据，重点看发生时间、来源、动作类型和文本内容。</p>
            </div>
            <div className="feedList" aria-label="记忆线索列表">
              {allEvents.map((event) => (
                <EventRow key={event.id ?? `${event.source}-${event.text}`} event={event} subtitle="记忆线索" onClick={setInspector} />
              ))}
            </div>
          </div>
        );
      case "dreaming":
        return (
          <div className="overviewPanel">
            <div className="overviewPanelHeader">
              <span className="sectionLabel">后台归纳</span>
              <h3>Dreaming 时间线</h3>
              <p>这里就是每一次 Dreaming run 的列表。每条只看时间、状态、摘要和高亮，不混入生成卡片的信息。</p>
            </div>
            <div className="overviewHero">
              <strong>{stringifyValue(dreamRunSummary.text ?? readObject(latestSnapshot).summary ?? "暂无摘要")}</strong>
              <p>最新一次运行：{formatDate((latestDreamRun.completedAt as string | undefined) ?? (dreamingFacts.lastRunAt as string | undefined) ?? null)}</p>
              <div className="miniStatRow">
                <span>{displayedDreamRuns.length} 条 Dreaming</span>
                <span>{dreamingHighlightCount} 条高亮</span>
                <span>{dreamingCandidateCount} 个候选</span>
              </div>
            </div>
            <div className="feedList" aria-label="Dreaming 列表">
              {displayedDreamRuns.map((run, index) => (
                <DreamRunRow key={stringifyValue(run.id ?? `dream-${index}`)} run={run} onClick={setInspector} />
              ))}
            </div>
          </div>
        );
      case "cards":
        return (
          <div className="overviewPanel">
            <div className="overviewPanelHeader">
              <span className="sectionLabel">生成卡片</span>
              <h3>生成卡片总览</h3>
              <p>重点看每张卡片的生成时间、标题、摘要和评分，而不是只看生成数量。</p>
            </div>
            <div className="feedList" aria-label="生成卡片列表">
              {generatedCards.map((card, index) => (
                <GeneratedCardRow key={stringifyValue(card.id ?? `card-${index}`)} card={card} onClick={setInspector} />
              ))}
            </div>
          </div>
        );
      case "feedback":
        return (
          <div className="overviewPanel">
            <div className="overviewPanelHeader">
              <span className="sectionLabel">卡片反馈</span>
              <h3>卡片反馈记录</h3>
              <p>这里展示用户对卡片的打开、确认、修改、忽略等行为，重点也是时间和卡片内容关联。</p>
            </div>
            <div className="feedList" aria-label="卡片反馈列表">
              {feedbackEvents.map((item, index) => (
                <FeedbackRow
                  key={stringifyValue(item.id ?? `feedback-${index}`)}
                  item={item}
                  cardTitle={typeof item.intentCardId === "string" ? generatedCardTitleById[item.intentCardId] : undefined}
                  onClick={setInspector}
                />
              ))}
            </div>
          </div>
        );
      case "connectors":
        return (
          <div className="overviewPanel">
            <div className="overviewPanelHeader">
              <span className="sectionLabel">原始连接器</span>
              <h3>连接器原始输入</h3>
              <p>先按来源看 Gmail、Google Drive、Notion、GitHub 这些分类，再往下看这个来源里真正抓到了什么内容。</p>
            </div>
            <div className="overviewBlock">
              <h4>连接器分类</h4>
              <div className="chipWrap" aria-label="连接器分类列表">
                {connectorKeys.map((key) => {
                  const item = connectorGroups[key];
                  return (
                    <button
                      key={key}
                      type="button"
                      className={`chipButton${selectedConnectorKey === key ? " accent" : ""}`}
                      onClick={() => {
                        setActiveConnector(key);
                        setInspector({
                          title: translateConnector(key),
                          subtitle: "连接器分类",
                          payload: item,
                        });
                      }}
                    >
                      {translateConnector(key)} · {stringifyValue(item.itemCount ?? 0)}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="overviewHero">
              <strong>{translateConnector(selectedConnectorKey ?? undefined)}</strong>
              <p>
                状态 {stringifyValue(selectedConnector?.status ?? "—")} · 原始项 {stringifyValue(selectedConnector?.itemCount ?? 0)} · 工具调用{" "}
                {stringifyValue(selectedConnector?.toolRunCount ?? 0)}
              </p>
              <div className="miniStatRow">
                <span>{selectedConnectorTimeline.length} 条原始记录</span>
                <span>{stringifyValue(selectedConnector?.reason ?? "无异常")}</span>
              </div>
            </div>
            <div className="feedList" aria-label="连接器原始输入列表">
              {selectedConnectorTimeline.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="eventRow"
                  onClick={() =>
                    setInspector({
                      title: item.title,
                      subtitle: item.subtitle,
                      payload: item.payload,
                    })
                  }
                >
                  <div className="memoryRowTop">
                    <div className="eventBadges">
                      <span className="pill accent">{translateConnector(selectedConnectorKey ?? undefined)}</span>
                      <span className="pill">{item.subtitle.split(" · ")[1] ?? "原始项"}</span>
                    </div>
                    <span className="timePill">{formatDate(item.timestamp)}</span>
                  </div>
                  <strong>{item.title}</strong>
                  <small>{item.subtitle}</small>
                </button>
              ))}
            </div>
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="appShell">
      <header className="hero">
        <div className="heroCopy">
          <p className="eyebrow">Proactive AI / Local Tool / Port 18101</p>
          <h1>记忆驾驶盘</h1>
          <p className="heroText">
            左边只看两件事: 现在到底存了什么，以及生成卡片时这些记忆会怎么被用上。右边始终保留详情查看。
          </p>
        </div>
        <div className="heroActions">
          <button type="button" onClick={() => setJsonText(sampleJson)}>
            载入示例数据
          </button>
          <button type="button" onClick={() => void loadRealData()}>
            {realDataStatus === "loading" ? "加载真实数据中..." : "载入真实数据"}
          </button>
          <label className="fileButton">
            导入 JSON
            <input type="file" accept="application/json" onChange={onFileImport} />
          </label>
        </div>
      </header>

      <details className="toolbox">
        <summary>数据源工具</summary>
        <div className="toolboxBody">
          <div className="toolboxMeta">
            <span className={`statusBadge ${realDataStatus}`}>真实数据: {realDataStatus}</span>
            <span>支持直接贴 `pin memory context/entries/events --json` 的原始输出。</span>
          </div>
          <div className="toolboxGrid">
            <label>
              <span>上下文输出</span>
              <textarea value={contextText} onChange={(event) => setContextText(event.target.value)} spellCheck={false} />
            </label>
            <label>
              <span>记忆结论输出</span>
              <textarea value={entriesText} onChange={(event) => setEntriesText(event.target.value)} spellCheck={false} />
            </label>
            <label>
              <span>记忆线索输出</span>
              <textarea value={eventsText} onChange={(event) => setEventsText(event.target.value)} spellCheck={false} />
            </label>
          </div>
          <div className="toolboxActions">
            <button type="button" onClick={assembleFromCommands}>
              组装成主载荷
            </button>
            <textarea value={jsonText} onChange={(event) => setJsonText(event.target.value)} spellCheck={false} />
          </div>
          {parsed.error ? <p className="errorText">JSON 解析失败: {parsed.error}</p> : null}
        </div>
      </details>

      <div className="pageLayout">
        <main className="leftColumn">
          <Panel title="当前状态" hint="上面的数字卡是主导航。点哪一类，下面就只展示这一类的主面板。">
            <div className="storageGrid">
              <StorageCard
                title="Profile"
                value={effectiveProfile.id ? 1 : 0}
                subtitle="`profiles` 稳定画像: summary / goals / preferences / constraints / interests"
                active={activeOverview === "profile"}
                onClick={() =>
                  activateOverview("profile", {
                    title: "用户画像",
                    subtitle: "`profiles` 稳定画像",
                    payload: effectiveProfile,
                  })
                }
              />
              <StorageCard
                title="Memory Entries"
                value={allEntries.length}
                subtitle="`memory_entries` 归纳后的记忆结论"
                active={activeOverview === "entries"}
                onClick={() =>
                  activateOverview("entries", {
                    title: "记忆结论池",
                    subtitle: "`memory_entries`",
                    payload: allEntries,
                  })
                }
              />
              <StorageCard
                title="Memory Events"
                value={allEvents.length}
                subtitle="`memory_events`: chat / feedback / dreaming 原始线索"
                active={activeOverview === "events"}
                onClick={() =>
                  activateOverview("events", {
                    title: "记忆线索池",
                    subtitle: "`memory_events`",
                    payload: allEvents,
                  })
                }
              />
              <StorageCard
                title="Dreaming"
                value={displayedDreamRuns.length}
                subtitle="Dreaming runs + summary / delta / source stats"
                active={activeOverview === "dreaming"}
                onClick={() =>
                  activateOverview("dreaming", {
                    title: "后台归纳状态",
                    subtitle: "来自 `facts.dreaming` + `snapshots`",
                    payload: {
                      facts: dreamingFacts,
                      latestSnapshot,
                    },
                  })
                }
              />
              <StorageCard
                title="Generated Cards"
                value={generatedCards.length}
                subtitle="最近 pipeline 产出的卡片"
                active={activeOverview === "cards"}
                onClick={() =>
                  activateOverview("cards", {
                    title: "最近生成卡片",
                    subtitle: "来自 runs.json 的 finalCards",
                    payload: generatedCards,
                  })
                }
              />
              <StorageCard
                title="Feedback Events"
                value={feedbackEvents.length}
                subtitle="来自 feedback_events 的行为记录"
                active={activeOverview === "feedback"}
                onClick={() =>
                  activateOverview("feedback", {
                    title: "卡片反馈",
                    subtitle: "用户对卡片的反馈/打开记录",
                    payload: feedbackEvents,
                  })
                }
              />
              <StorageCard
                title="Data Connectors"
                value={connectorRawItems.length}
                subtitle="最新 Dreaming 的 connector raw 输入"
                active={activeOverview === "connectors"}
                onClick={() =>
                  activateOverview("connectors", {
                    title: "连接器原始输入",
                    subtitle: "来自 latestDreamRawInputs.personal.connectors",
                    payload: {
                      connectorRawItems,
                      connectorRawSources,
                      latestDreamRawInputs,
                    },
                  })
                }
              />
            </div>
            {renderOverviewPanel()}
          </Panel>

          <details className="toolbox memoryToolbox">
            <summary>记忆怎么被用上</summary>
            <div className="toolboxBody">
              <div className="toolboxMeta">
                <span>默认收起。展开后可以模拟生成一张卡片时，系统如何先注入稳定画像，再按主题检索相关记忆。</span>
              </div>
              <div className="queryCard">
                <div className="queryInputRow">
                  <input
                    className="queryInput"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="输入卡片主题，比如 AI新闻、比特币、Supabase issue"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setInspector({
                        title: "模拟上下文包",
                        subtitle: "生成器最终会看到的内容",
                        payload: simulatedContextPack,
                      })
                    }
                  >
                    查看最终注入包
                  </button>
                </div>
                <div className="chipWrap">
                  {EXAMPLE_TOPICS.map((item) => (
                    <button key={item} type="button" className="chipButton" onClick={() => setQuery(item)}>
                      {item}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flowGrid">
                <div className="flowStep">
                  <span className="stepIndex">01</span>
                  <h3>先注入稳定画像</h3>
                  <p>每次生成都会先带上画像、目标、偏好、约束、兴趣和常驻记忆。</p>
                  <div className="miniStatRow">
                    <span>{goals.length} 个目标</span>
                    <span>{preferenceItems.length} 条偏好</span>
                    <span>{constraintItems.length} 条约束</span>
                    <span>{residentMemories.length} 条常驻记忆</span>
                  </div>
                </div>

                <div className="flowStep">
                  <span className="stepIndex">02</span>
                  <h3>把主题拆成关键词</h3>
                  <p>这里先做简单关键词拆分。后续如果要接真实后端，再换成完整 recall 逻辑。</p>
                  <div className="chipWrap">
                    {queryTerms.length > 0 ? queryTerms.map((term) => <span key={term} className="chipTag">{term}</span>) : <span className="emptyState">没有可用关键词</span>}
                  </div>
                </div>

                <div className="flowStep">
                  <span className="stepIndex">03</span>
                  <h3>搜索当前记忆</h3>
                  <p>先看常驻记忆是否被当前主题命中，再查 `memory_entries` 和 `memory_events` 里有哪些相关内容。</p>
                  <div className="miniStatRow">
                    <span>{residentHits.length} 条常驻命中</span>
                    <span>{entryHits.length} 条结论命中</span>
                    <span>{eventHits.length} 条线索命中</span>
                    <span>{relevantMemories.length} 条当前相关记忆</span>
                  </div>
                </div>

                <div className="flowStep">
                  <span className="stepIndex">04</span>
                  <h3>拼出最终上下文包</h3>
                  <p>最终给生成器的内容会是: 稳定画像 + 常驻记忆 + 主题命中的记忆 + 相关线索。</p>
                  <button
                    type="button"
                    className="outlineButton"
                    onClick={() =>
                      setInspector({
                        title: "上下文预览",
                        subtitle: "模拟的记忆应用结果",
                        payload: simulatedContextPack,
                      })
                    }
                  >
                    打开上下文预览
                  </button>
                </div>
              </div>

              <div className="applyGrid">
                <HitList
                  title="常驻记忆命中"
                  hits={residentHits}
                  empty="当前主题没直接命中常驻记忆，但常驻记忆仍会被默认注入。"
                  onClick={(hit) =>
                    setInspector({
                      title: hit.label,
                      subtitle: "常驻记忆命中",
                      payload: hit.item,
                    })
                  }
                />
                <HitList
                  title="归纳记忆命中"
                  hits={entryHits}
                  empty="当前主题没命中归纳后的记忆结论。"
                  onClick={(hit) =>
                    setInspector({
                      title: hit.label,
                      subtitle: "记忆结论命中",
                      payload: hit.item,
                    })
                  }
                />
                <HitList
                  title="记忆线索命中"
                  hits={eventHits}
                  empty="当前主题没命中记忆线索。"
                  onClick={(hit) =>
                    setInspector({
                      title: hit.label,
                      subtitle: "记忆线索命中",
                      payload: hit.item,
                    })
                  }
                />
              </div>

              <div className="stateBlock">
                <div className="stateBlockHeader">
                  <h3>最终上下文包预览</h3>
                </div>
                <pre className="previewJson">{JSON.stringify(simulatedContextPack, null, 2)}</pre>
              </div>
            </div>
          </details>
        </main>

        <aside className="inspectorRail">
          <Panel title="当前详情" hint="点左边任何一项，右侧只负责看细节。树形展开和原始 JSON 都支持，而且都是内部滚动。">
            <div className="selectedCard">
              <span className="sectionLabel">已选中</span>
              <h3>{inspector.title}</h3>
              <p>{inspector.subtitle}</p>
            </div>
            <div className="inspectorModes">
              <button type="button" className={inspectorMode === "tree" ? "active" : ""} onClick={() => setInspectorMode("tree")}>
                树形展开
              </button>
              <button type="button" className={inspectorMode === "raw" ? "active" : ""} onClick={() => setInspectorMode("raw")}>
                原始 JSON
              </button>
            </div>
            {inspectorMode === "tree" ? (
              <JsonExplorer value={inspector.payload} />
            ) : (
              <pre className="inspectorJson">{JSON.stringify(inspector.payload, null, 2)}</pre>
            )}
          </Panel>
        </aside>
      </div>
    </div>
  );
}
