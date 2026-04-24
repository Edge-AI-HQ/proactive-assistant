/**
 * Data source collectors for cloud dreaming.
 * Adapted from standalone service.ts — uses Supabase + Composio API directly.
 */

import type { DreamSourceResult } from './types.js';
import * as db from '../db.js';
import { requireComposioApiKey, getComposioUserId as sharedGetUserId } from '../shared/composio-key.js';

// ── Constants ──

const COMPOSIO_API_BASE = 'https://backend.composio.dev/api/v3';
const PERSONAL_PROVIDER_TIMEOUT_MS = 12_000;
const PERSONAL_TOOL_SEARCH_LIMIT = 100;
const PERSONAL_MAX_TOOL_CANDIDATES = 8;
const PERSONAL_MAX_TOOL_RUNS = 4;
const PERSONAL_MAX_TOOL_ATTEMPTS = 10;
const PERSONAL_MAX_NORMALIZED_ITEMS = 200;

const PERSONAL_TOOL_DISCOVERY_SUFFIXES = [
  'emails', 'events', 'messages', 'notifications', 'issues',
  'pull requests', 'pages', 'files', 'channels',
];
const PERSONAL_READ_KEYWORDS = [
  'search', 'fetch', 'list', 'get', 'history', 'read', 'recent',
  'message', 'email', 'event', 'issue', 'notification', 'thread',
  'conversation', 'page', 'file', 'note', 'document', 'activity',
];
const PERSONAL_WRITE_KEYWORDS = [
  'create', 'update', 'delete', 'remove', 'send', 'post', 'reply',
  'upload', 'insert', 'append', 'publish', 'disconnect', 'connect', 'write',
];
const DYNAMIC_TITLE_PATHS = [
  'subject', 'title', 'name', 'summary', 'preview.subject',
  'page_title', 'thread_title', 'channel', 'calendar',
];
const DYNAMIC_PREVIEW_PATHS = [
  'preview.body', 'snippet', 'description', 'summary', 'text',
  'body', 'messageText', 'content', 'excerpt',
];
const DYNAMIC_BODY_PATHS = [
  'messageText', 'body', 'content', 'text', 'description', 'preview.body',
];
const DYNAMIC_ACTOR_PATHS = [
  'sender', 'from', 'author.name', 'author.login', 'user.name',
  'user.login', 'creator.name', 'creator.login', 'assignee.login',
];
const DYNAMIC_TIMESTAMP_PATHS = [
  'messageTimestamp', 'internalDate', 'updated_at', 'updatedAt',
  'last_edited_time', 'created_time', 'createdAt', 'start',
  'start.dateTime', 'start.date', 'ts', 'date', 'time', 'occurredAt',
];
const DYNAMIC_URL_PATHS = [
  'display_url', 'html_url', 'url', 'permalink', 'link',
];

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

// ── Composio API helpers ──

interface PersonalToolInfo { slug: string; description: string | null; toolkit?: string | null; }
interface PersonalToolSchema { parameters?: Record<string, unknown>; }
interface DynamicPersonalToolCandidate { slug: string; description: string | null; schema: PersonalToolSchema | null; score: number; }
interface ExecutedPersonalToolRun { slug: string; description: string | null; args: Record<string, unknown>; itemCount: number; payload: unknown; }

// Composio API key + user id resolution lives in shared/composio-key.ts so
// the CLI and the dreaming agent agree on the same lookup order
// (file → env). See its module doc for why.
const getComposioApiKey = requireComposioApiKey;
const getComposioUserId = sharedGetUserId;

async function composioApi(apiKey: string, path: string, init?: RequestInit): Promise<Record<string, any>> {
  const response = await fetch(`${COMPOSIO_API_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  const data = text.trim() ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`Composio API ${response.status}: ${data.message ?? data.error ?? text.slice(0, 200)}`);
  return data;
}

async function withTimeout<T>(label: string, promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

// ── Text / object helpers ──

function compactText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const compacted = value.replace(/\s+/g, ' ').trim();
  return compacted.length > 0 ? compacted : null;
}

function truncateText(value: string | null, maxLength = 600): string | null {
  if (!value) return null;
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function arrayOfObjects(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item));
}

function readObjectPath(value: unknown, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = value;
  for (const part of parts) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function pickTextByPaths(record: Record<string, unknown>, paths: string[]): string | null {
  for (const path of paths) {
    const value = readObjectPath(record, path);
    const text = compactText(value);
    if (text) return text;
  }
  return null;
}

function joinContextParts(parts: Array<unknown>): string | null {
  const values = parts.map((v) => compactText(v)).filter((v): v is string => !!v);
  if (values.length === 0) return null;
  return values.join(' | ');
}

function parseIso(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseLooseTimestamp(value: unknown): Date | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value > 10_000_000_000 ? value : value * 1000;
    const parsed = new Date(millis);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (/^\d+\.\d+$/.test(trimmed)) {
    const parsed = new Date(Number(trimmed.split('.')[0]) * 1000);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (/^\d{9,13}$/.test(trimmed)) {
    const numeric = Number(trimmed);
    const millis = trimmed.length >= 12 ? numeric : numeric * 1000;
    const parsed = new Date(millis);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return parseIso(trimmed);
}

function inferItemCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (!value || typeof value !== 'object') return 0;
  const record = value as Record<string, unknown>;
  if (typeof record.itemCount === 'number' && Number.isFinite(record.itemCount)) return record.itemCount;
  if (Array.isArray(record.messages)) return arrayOfObjects(record.messages).length;
  if (Array.isArray(record.summary_view)) return record.summary_view.length;
  if (typeof record.summary_view === 'string') {
    return record.summary_view.split('\n').filter((line) => line.trim().length > 0).length;
  }
  if (Array.isArray(record.events) && record.events.length > 0) return record.events.length;
  if (Array.isArray(record.items)) return record.items.length;
  if (Array.isArray(record.results)) return record.results.length;
  let count = 0;
  for (const entry of Object.values(record)) {
    if (Array.isArray(entry)) count += entry.length;
  }
  return count;
}

function unwrapComposioDataPreview(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (record.data_preview && typeof record.data_preview === 'object' && !Array.isArray(record.data_preview)) {
    return record.data_preview;
  }
  if (record.data && typeof record.data === 'object' && !Array.isArray(record.data)) {
    return unwrapComposioDataPreview(record.data);
  }
  return value;
}

function formatReadableDatePart(value: number): string {
  return String(value).padStart(2, '0');
}

function toIsoDateString(value: string): string | null {
  const parsed = parseIso(value);
  if (!parsed) return null;
  return `${parsed.getUTCFullYear()}-${formatReadableDatePart(parsed.getUTCMonth() + 1)}-${formatReadableDatePart(parsed.getUTCDate())}`;
}

function toSlashDateString(value: string): string | null {
  const parsed = parseIso(value);
  if (!parsed) return null;
  return `${parsed.getUTCFullYear()}/${formatReadableDatePart(parsed.getUTCMonth() + 1)}/${formatReadableDatePart(parsed.getUTCDate())}`;
}

function toRelativeSince(windowStart: string, windowEnd: string): string {
  const start = parseIso(windowStart);
  const end = parseIso(windowEnd);
  if (!start || !end) return '24h';
  const diffMs = Math.max(MS_PER_HOUR, end.getTime() - start.getTime());
  const hours = Math.max(1, Math.ceil(diffMs / MS_PER_HOUR));
  if (hours <= 48) return `${hours}h`;
  const days = Math.max(1, Math.ceil(diffMs / MS_PER_DAY));
  if (days <= 21) return `${days}d`;
  return `${Math.max(1, Math.ceil(days / 7))}w`;
}

// ── Tool discovery & ranking ──

function humanizeToolkitForQuery(toolkit: string): string {
  return toolkit
    .replace(/googlecalendar/gi, 'google calendar')
    .replace(/googledrive/gi, 'google drive')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
}

function buildToolkitDiscoveryQueries(toolkit: string): string[] {
  const humanized = humanizeToolkitForQuery(toolkit);
  const rawQueries = [
    humanized,
    ...PERSONAL_TOOL_DISCOVERY_SUFFIXES.map((s) => `${humanized} ${s}`),
  ];
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const query of rawQueries.map((v) => v.trim()).filter((v) => v.length > 0)) {
    const normalized = query.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(query);
  }
  return deduped.slice(0, 5);
}

function rankDynamicPersonalToolCandidate(toolkit: string, tool: PersonalToolInfo, schema: PersonalToolSchema | null): number {
  const text = `${tool.slug} ${tool.description ?? ''}`.toLowerCase();
  let score = 0;
  for (const keyword of PERSONAL_READ_KEYWORDS) { if (text.includes(keyword)) score += 3; }
  for (const keyword of PERSONAL_WRITE_KEYWORDS) { if (text.includes(keyword)) score -= 5; }
  const parameters = schema?.parameters && typeof schema.parameters === 'object' && !Array.isArray(schema.parameters)
    ? schema.parameters as Record<string, unknown> : {};
  const required = Array.isArray(parameters.required) ? parameters.required.filter((i): i is string => typeof i === 'string') : [];
  if (required.includes('owner') || required.includes('repo') || required.includes('channel')) score -= 6;
  if (required.length <= 2) score += 2;
  if (toolkit === 'gmail') {
    if (text.includes('fetch') && text.includes('email')) score += 18;
    if (text.includes('profile')) score -= 12;
  }
  if (toolkit === 'googlecalendar') {
    if (text.includes('events_list_all_calendars') || (text.includes('list') && text.includes('calendar'))) score += 18;
    if (text.includes('find_event')) score -= 10;
  }
  if (toolkit === 'slack') {
    if (text.includes('search_all') || text.includes('search messages')) score += 18;
    if (text.includes('find_channels')) score -= 12;
  }
  if (toolkit === 'github') {
    if (text.includes('issues_assigned_to_the_authenticated_user')) score += 20;
    if (text.includes('docker') || text.includes('migration conflict') || text.includes('conflict packages')) score -= 18;
  }
  if (toolkit === 'googledrive') {
    if (text.includes('find_file') || text.includes('list file')) score += 8;
    if (text.includes('list_changes')) score -= 10;
  }
  if (toolkit === 'notion') {
    if (text.includes('search') || text.includes('fetch_data')) score += 6;
  }
  return score;
}

// ── Tool argument building ──

function buildGenericQueryVariants(windowStart: string, windowEnd: string): string[] {
  const startIso = toIsoDateString(windowStart);
  const endIso = toIsoDateString(windowEnd);
  const startSlash = toSlashDateString(windowStart);
  const endSlash = toSlashDateString(windowEnd);
  const variants = [
    startIso && endIso ? `after:${startIso} before:${endIso}` : null,
    startSlash && endSlash ? `after:${startSlash} before:${endSlash}` : null,
    startIso ? `updated:>=${startIso}` : null,
    `modifiedTime > '${windowStart}' and modifiedTime < '${windowEnd}'`,
    startIso ? `since ${startIso}` : null,
  ];
  return variants.filter((v): v is string => !!v);
}

function buildDefaultScalarForSchemaProperty(
  key: string,
  property: Record<string, unknown>,
  windowStart: string,
  windowEnd: string,
): unknown {
  const n = key.toLowerCase();
  if (n === 'since') return windowStart;
  if (n === 'time_min' || n === 'start_time' || n === 'date_from') return windowStart;
  if (n === 'time_max' || n === 'end_time' || n === 'date_to') return windowEnd;
  if (n === 'after') return Math.floor(new Date(windowStart).getTime() / 1000).toString();
  if (n === 'before') return Math.floor(new Date(windowEnd).getTime() / 1000).toString();
  if (n === 'oldest') return Math.floor(new Date(windowStart).getTime() / 1000).toString();
  if (n === 'latest') return Math.floor(new Date(windowEnd).getTime() / 1000).toString();
  if (n === 'limit' || n === 'count' || n === 'page_size' || n === 'per_page' || n === 'max_results') return 100;
  if (n === 'state' || n === 'filter') return 'all';
  if (n === 'sort') return 'timestamp';
  if (n === 'sort_dir' || n === 'order' || n === 'direction') return 'desc';
  if (n === 'summary_only') return false;
  if (n === 'single_events') return true;
  if (n === 'include_context') return true;
  if (n === 'include_archived') return false;
  if (n === 'include_bots') return false;
  if (n === 'fetch_type') return 'all';
  if (n === 'spaces') return 'drive';
  if (n === 'corpora') return 'user';
  if (n === 'response_format') return 'detailed';
  if (n === 'content_types') return 'messages';

  const enumValues = Array.isArray(property.enum) ? property.enum.filter((i): i is string => typeof i === 'string') : [];
  if (enumValues.includes('all')) return 'all';
  if (enumValues.includes('timestamp')) return 'timestamp';
  if (enumValues.includes('desc')) return 'desc';
  if (enumValues.includes('detailed')) return 'detailed';
  if (enumValues.length === 1) return enumValues[0];
  return undefined;
}

function filterArgumentVariantBySchema(
  propertyBag: Record<string, Record<string, unknown>>,
  required: string[],
  args: Record<string, unknown>,
): Record<string, unknown> | null {
  const filtered = Object.fromEntries(
    Object.entries(args).filter(([key, value]) => key in propertyBag && value !== undefined),
  );
  if (required.some((key) => !(key in filtered))) return null;
  return filtered;
}

function buildConnectorSpecificArgumentVariants(
  toolkit: string,
  slug: string,
  propertyBag: Record<string, Record<string, unknown>>,
  required: string[],
  windowStart: string,
  windowEnd: string,
): Array<Record<string, unknown>> {
  const nt = toolkit.toLowerCase();
  const ns = slug.toLowerCase();
  const startIso = toIsoDateString(windowStart);
  const endIso = toIsoDateString(windowEnd);
  const queryWindow = [
    startIso ? `after:${startIso}` : null,
    endIso ? `before:${endIso}` : null,
  ].filter((v): v is string => !!v).join(' ');

  const variants: Array<Record<string, unknown>> = [];

  if (nt === 'gmail' && ns.includes('fetch') && ns.includes('email')) {
    variants.push({ query: queryWindow || undefined, max_results: 100, include_payload: true, verbose: true });
  }
  if (nt === 'googlecalendar' && ns.includes('events_list_all_calendars')) {
    variants.push({ time_min: windowStart, time_max: windowEnd, single_events: true, summary_only: false, max_results: 100 });
  }
  if (nt === 'slack' && (ns.includes('search_all') || ns.includes('search_messages'))) {
    variants.push({
      query: queryWindow || `after:${toIsoDateString(windowStart) ?? ''}`.trim(),
      count: 100, sort: 'timestamp', sort_dir: 'desc', include_bots: false, include_context: true,
    });
  }
  if (nt === 'github' && ns.includes('issues_assigned_to_the_authenticated_user')) {
    variants.push({ since: windowStart, state: 'all', filter: 'assigned', per_page: 100, direction: 'desc' });
  }
  if (nt === 'googledrive' && ns.includes('find_file')) {
    variants.push({ q: `modifiedTime > '${windowStart}' and modifiedTime < '${windowEnd}'`, page_size: 100, spaces: 'drive', corpora: 'user' });
  }
  if (nt === 'notion' && ns.includes('fetch_data')) {
    variants.push({ fetch_type: 'get_all', page_size: 100, query: queryWindow || undefined });
  }

  const filtered = variants
    .map((args) => filterArgumentVariantBySchema(propertyBag, required, args))
    .filter((args): args is Record<string, unknown> => !!args);
  return filtered.filter((args, index, list) =>
    list.findIndex((c) => JSON.stringify(c) === JSON.stringify(args)) === index,
  );
}

function buildToolArgumentVariants(
  toolkit: string,
  slug: string,
  schema: PersonalToolSchema | null,
  windowStart: string,
  windowEnd: string,
): Array<Record<string, unknown>> {
  const parameters = schema?.parameters && typeof schema.parameters === 'object' && !Array.isArray(schema.parameters)
    ? schema.parameters as Record<string, unknown> : {};
  const propertyBag = parameters.type === 'object' && parameters.properties && typeof parameters.properties === 'object' && !Array.isArray(parameters.properties)
    ? parameters.properties as Record<string, Record<string, unknown>>
    : parameters as Record<string, Record<string, unknown>>;
  const required = Array.isArray(parameters.required)
    ? parameters.required.filter((i): i is string => typeof i === 'string') : [];

  const connectorSpecific = buildConnectorSpecificArgumentVariants(toolkit, slug, propertyBag, required, windowStart, windowEnd);
  if (connectorSpecific.length > 0) return connectorSpecific;

  const queryKeys = Object.keys(propertyBag).filter((k) => {
    const n = k.toLowerCase();
    return n === 'query' || n === 'q' || n === 'search_query';
  });
  const baseArgs: Record<string, unknown> = {};
  for (const [key, property] of Object.entries(propertyBag)) {
    if (queryKeys.includes(key)) continue;
    const value = buildDefaultScalarForSchemaProperty(key, property, windowStart, windowEnd);
    if (value !== undefined) baseArgs[key] = value;
  }
  const queryVariants = queryKeys.length > 0 ? buildGenericQueryVariants(windowStart, windowEnd) : [null];
  const variants = queryVariants.map((qv) => {
    const args = { ...baseArgs };
    if (qv !== null) { for (const key of queryKeys) args[key] = qv; }
    return args;
  });
  return variants.filter((args, index, list) => {
    const missingRequired = required.filter((k) => !(k in args));
    if (missingRequired.length > 0) return false;
    return list.findIndex((c) => JSON.stringify(c) === JSON.stringify(args)) === index;
  });
}

// ── Tool discovery ──

async function searchTools(apiKey: string, query: string, toolkit: string): Promise<PersonalToolInfo[]> {
  const params = new URLSearchParams({ query, limit: String(PERSONAL_TOOL_SEARCH_LIMIT), toolkit_versions: 'latest', toolkit_slug: toolkit });
  const data = await composioApi(apiKey, `/tools?${params}`);
  const items = Array.isArray(data.items) ? data.items : [];
  return items.map((item: any) => ({
    slug: item.slug ?? 'unknown',
    description: item.description ?? null,
    toolkit: item.toolkit?.slug ?? null,
  }));
}

async function getToolSchema(apiKey: string, slug: string): Promise<PersonalToolSchema | null> {
  try {
    const tool = await composioApi(apiKey, `/tools/${encodeURIComponent(slug)}?toolkit_versions=latest`);
    return { parameters: tool.input_parameters ?? tool.inputSchema ?? {} };
  } catch {
    return null;
  }
}

async function discoverDynamicPersonalToolCandidates(apiKey: string, toolkit: string): Promise<DynamicPersonalToolCandidate[]> {
  const discovered = new Map<string, PersonalToolInfo>();
  for (const query of buildToolkitDiscoveryQueries(toolkit)) {
    const tools = await withTimeout(
      `searchTools(${toolkit}:${query})`,
      searchTools(apiKey, query, toolkit),
      PERSONAL_PROVIDER_TIMEOUT_MS,
    );
    for (const tool of tools) {
      if (!discovered.has(tool.slug)) discovered.set(tool.slug, tool);
    }
  }

  const candidates: DynamicPersonalToolCandidate[] = [];
  for (const tool of discovered.values()) {
    const schema = await withTimeout(
      `getToolSchema(${tool.slug})`,
      getToolSchema(apiKey, tool.slug),
      PERSONAL_PROVIDER_TIMEOUT_MS,
    );
    const score = rankDynamicPersonalToolCandidate(toolkit, tool, schema);
    if (score <= 0) continue;
    candidates.push({ slug: tool.slug, description: tool.description, schema, score });
  }

  return candidates
    .sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug))
    .slice(0, PERSONAL_MAX_TOOL_CANDIDATES);
}

// ── Tool execution ──

async function executeTool(
  apiKey: string,
  userId: string,
  slug: string,
  args: Record<string, unknown>,
  connectedAccountId?: string,
): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    const result = await composioApi(apiKey, `/tools/execute/${encodeURIComponent(slug)}`, {
      method: 'POST',
      body: JSON.stringify({
        user_id: userId,
        ...(connectedAccountId ? { connected_account_id: connectedAccountId } : {}),
        arguments: args,
      }),
    });
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Data normalization ──

function collectDynamicCandidateObjects(value: unknown, output: Array<Record<string, unknown>>, depth = 0): void {
  if (output.length >= PERSONAL_MAX_NORMALIZED_ITEMS || depth > 5 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      collectDynamicCandidateObjects(item, output, depth + 1);
      if (output.length >= PERSONAL_MAX_NORMALIZED_ITEMS) return;
    }
    return;
  }
  if (typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const hasContentLikeField = keys.some((k) => {
    const n = k.toLowerCase();
    return n.includes('subject') || n.includes('title') || n.includes('text')
      || n.includes('body') || n.includes('summary') || n.includes('message')
      || n.includes('description') || n.includes('snippet') || n.includes('content')
      || n.includes('name');
  });
  if (hasContentLikeField) output.push(record);
  for (const child of Object.values(record)) {
    collectDynamicCandidateObjects(child, output, depth + 1);
    if (output.length >= PERSONAL_MAX_NORMALIZED_ITEMS) return;
  }
}

function isTimestampInWindow(timestamp: Date | null, windowStart: string, windowEnd: string): boolean {
  if (!timestamp) return true;
  const start = parseIso(windowStart);
  const end = parseIso(windowEnd);
  if (start && timestamp < start) return false;
  if (end && timestamp > end) return false;
  return true;
}

function normalizeDynamicPersonalRecord(
  toolkit: string,
  slug: string,
  record: Record<string, unknown>,
  windowStart: string,
  windowEnd: string,
): Record<string, unknown> | null {
  const timestampValue = DYNAMIC_TIMESTAMP_PATHS.map((p) => readObjectPath(record, p)).find((v) => v != null);
  const timestamp = parseLooseTimestamp(timestampValue);
  if (!isTimestampInWindow(timestamp, windowStart, windowEnd)) return null;

  const title = pickTextByPaths(record, DYNAMIC_TITLE_PATHS)
    ?? truncateText(pickTextByPaths(record, DYNAMIC_PREVIEW_PATHS), 120)
    ?? null;
  const preview = truncateText(pickTextByPaths(record, DYNAMIC_PREVIEW_PATHS), 600);
  const body = truncateText(pickTextByPaths(record, DYNAMIC_BODY_PATHS), 1600);
  const actor = pickTextByPaths(record, DYNAMIC_ACTOR_PATHS);
  const url = pickTextByPaths(record, DYNAMIC_URL_PATHS);
  const context = joinContextParts([
    title, actor, preview, body,
    compactText(record.channel), compactText(record.calendar),
  ]);

  if (!title && !preview && !body && !context) return null;

  return {
    connector: toolkit,
    tool: slug,
    title: title ?? `${toolkit} item`,
    timestamp: timestamp?.toISOString() ?? compactText(timestampValue) ?? windowEnd,
    actor, preview, body, url, context,
  };
}

function normalizeDynamicPersonalData(
  toolkit: string,
  toolRuns: ExecutedPersonalToolRun[],
  windowStart: string,
  windowEnd: string,
): Array<Record<string, unknown>> {
  const normalized: Array<Record<string, unknown>> = [];

  for (const toolRun of toolRuns) {
    const unwrapped = unwrapComposioDataPreview(toolRun.payload);
    const summaryView = unwrapped && typeof unwrapped === 'object' && !Array.isArray(unwrapped)
      ? (unwrapped as Record<string, unknown>).summary_view : null;
    if (typeof summaryView === 'string') {
      const lines = summaryView.split('\n').map((l) => compactText(l)).filter((l): l is string => !!l).slice(0, PERSONAL_MAX_NORMALIZED_ITEMS);
      for (const line of lines) {
        normalized.push({
          connector: toolkit, tool: toolRun.slug,
          title: line.replace(/^\d+[\.\)]\s*/, ''),
          timestamp: windowEnd, context: line,
        });
      }
      continue;
    }

    const candidates: Array<Record<string, unknown>> = [];
    collectDynamicCandidateObjects(unwrapped, candidates);
    for (const candidate of candidates) {
      const entry = normalizeDynamicPersonalRecord(toolkit, toolRun.slug, candidate, windowStart, windowEnd);
      if (entry) normalized.push(entry);
      if (normalized.length >= PERSONAL_MAX_NORMALIZED_ITEMS) break;
    }
    if (normalized.length >= PERSONAL_MAX_NORMALIZED_ITEMS) break;
  }

  // Deduplicate
  const deduped: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const entry of normalized) {
    const sig = JSON.stringify([entry.connector, entry.tool, entry.title, entry.timestamp, entry.url, entry.preview]);
    if (seen.has(sig)) continue;
    seen.add(sig);
    deduped.push(entry);
  }

  // Sort by timestamp desc
  return deduped
    .sort((a, b) => {
      const aTime = typeof a.timestamp === 'string' ? parseLooseTimestamp(a.timestamp)?.getTime() ?? 0 : 0;
      const bTime = typeof b.timestamp === 'string' ? parseLooseTimestamp(b.timestamp)?.getTime() ?? 0 : 0;
      return bTime - aTime;
    })
    .slice(0, PERSONAL_MAX_NORMALIZED_ITEMS);
}

async function executeDynamicConnectorTools(
  apiKey: string,
  userId: string,
  connection: { toolkit: string; connectedAccountId: string | null },
  windowStart: string,
  windowEnd: string,
): Promise<{ toolRuns: ExecutedPersonalToolRun[]; attempts: number; skippedReason?: string }> {
  const candidates = await discoverDynamicPersonalToolCandidates(apiKey, connection.toolkit);
  if (candidates.length === 0) {
    return { toolRuns: [], attempts: 0, skippedReason: 'No usable read tools discovered' };
  }

  const toolRuns: ExecutedPersonalToolRun[] = [];
  let attempts = 0;
  for (const candidate of candidates) {
    const variants = buildToolArgumentVariants(connection.toolkit, candidate.slug, candidate.schema, windowStart, windowEnd);
    if (variants.length === 0) continue;
    for (const args of variants) {
      const result = await withTimeout(
        `executeTool(${candidate.slug})`,
        executeTool(apiKey, userId, candidate.slug, args, connection.connectedAccountId ?? undefined),
        PERSONAL_PROVIDER_TIMEOUT_MS,
      );
      attempts += 1;
      if (!result.success) {
        if (attempts >= PERSONAL_MAX_TOOL_ATTEMPTS) {
          return { toolRuns, attempts, skippedReason: result.error ?? 'Tool execution failed' };
        }
        continue;
      }
      const payload = result.data;
      const itemCount = inferItemCount(unwrapComposioDataPreview(payload));
      toolRuns.push({ slug: candidate.slug, description: candidate.description, args, itemCount, payload });
      if (toolRuns.length >= PERSONAL_MAX_TOOL_RUNS || attempts >= PERSONAL_MAX_TOOL_ATTEMPTS) {
        return { toolRuns, attempts };
      }
      if (itemCount > 0) break;
    }
    if (toolRuns.length >= PERSONAL_MAX_TOOL_RUNS || attempts >= PERSONAL_MAX_TOOL_ATTEMPTS) break;
  }

  return {
    toolRuns, attempts,
    ...(toolRuns.length > 0 ? {} : { skippedReason: 'No connector data returned in the current window' }),
  };
}

// ── Source collectors ──

export async function collectSignals(windowStart: string): Promise<DreamSourceResult> {
  const signals = await db.listPersonalSignals({
    status: 'open',
    since: windowStart,
    limit: 500,
    pruneExpired: true,
  });
  return { status: 'ok', count: signals.length, raw: signals, normalized: signals };
}

export async function collectFeedback(windowStart: string, windowEnd: string): Promise<DreamSourceResult> {
  const rows = await db.listFeedback({ since: windowStart, limit: 50 });
  return { status: 'ok', count: rows.length, raw: rows, normalized: rows };
}

export async function collectCards(windowStart: string): Promise<DreamSourceResult> {
  const latestRun = await db.getLatestPipelineRun();
  if (!latestRun || !latestRun.started_at || latestRun.started_at < windowStart) {
    return { status: 'skipped', count: 0, raw: [], normalized: [], message: 'No recent cards' };
  }
  const cards = Array.isArray(latestRun.final_cards)
    ? (latestRun.final_cards as Array<Record<string, unknown>>).map((card) => ({
        runId: latestRun.run_id,
        completedAt: latestRun.completed_at,
        ...card,
      }))
    : [];
  return {
    status: cards.length > 0 ? 'ok' : 'skipped',
    count: cards.length, raw: cards, normalized: cards,
    message: cards.length > 0 ? undefined : 'No recent cards',
  };
}

export async function collectPersonal(windowStart: string, windowEnd: string): Promise<DreamSourceResult> {
  const apiKey = getComposioApiKey();
  const userId = getComposioUserId();

  const accountsData = await withTimeout(
    'discoverConnections(personal)',
    composioApi(apiKey, `/connected_accounts?user_ids=${userId}&statuses=ACTIVE&limit=100`),
    PERSONAL_PROVIDER_TIMEOUT_MS,
  );
  const items = Array.isArray(accountsData.items) ? accountsData.items : [];
  const active = items.map((item: any) => ({
    toolkit: item.toolkit?.slug ?? item.toolkit ?? 'unknown',
    connectedAccountId: item.id ?? item.connected_account_id ?? null,
  }));

  const connectors: Record<string, unknown> = {};
  const normalized: Array<Record<string, unknown>> = [];

  for (const connection of active) {
    try {
      const { toolRuns, skippedReason } = await executeDynamicConnectorTools(apiKey, userId, connection, windowStart, windowEnd);
      const connectorEntries = normalizeDynamicPersonalData(connection.toolkit, toolRuns, windowStart, windowEnd);
      normalized.push(...connectorEntries);
      connectors[connection.toolkit] = {
        status: connectorEntries.length > 0 ? 'ok' : 'skipped',
        itemCount: connectorEntries.length,
        toolRuns: toolRuns.map((tr) => ({
          slug: tr.slug, description: tr.description, args: tr.args,
          itemCount: tr.itemCount, payload: tr.payload,
        })),
        ...(connectorEntries.length > 0 ? {} : { reason: skippedReason ?? 'No connector data returned in the current window' }),
      };
    } catch (error) {
      connectors[connection.toolkit] = {
        status: 'error', itemCount: 0,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const count = normalized.length;
  return {
    status: count > 0 ? 'ok' : 'skipped',
    count, raw: { connectors }, normalized,
    message: count > 0 ? undefined : 'No personal connector data collected',
  };
}
