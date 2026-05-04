export const COMPOSIO_READ_VERBS = new Set([
  'GET',
  'FETCH',
  'SEARCH',
  'LIST',
  'READ',
  'QUERY',
  'LOOKUP',
  'RETRIEVE',
  'FIND',
]);

export const COMPOSIO_SAFE_WRITE_VERBS = new Set([
  'CREATE',
  'UPDATE',
  'SEND',
  'POST',
  'REPLY',
  'DRAFT',
  'SCHEDULE',
  'PUBLISH',
  'UPLOAD',
  'ADD',
  'INSERT',
  'PATCH',
  'SUBMIT',
  'FORWARD',
  'INVITE',
]);

export const COMPOSIO_DANGEROUS_WRITE_VERBS = new Set([
  'DELETE',
  'REMOVE',
  'CANCEL',
  'TRANSFER',
  'CHARGE',
  'PAY',
  'PURCHASE',
  'ARCHIVE',
  'MOVE',
  'EXECUTE',
  'RUN',
]);

export type ComposioToolClassification =
  | { kind: 'read'; verb: string }
  | { kind: 'safe_write'; verb: string }
  | { kind: 'dangerous_write'; verb: string }
  | { kind: 'blocked'; verb: string; reason: string }
  | { kind: 'unknown'; reason: string };

export interface ComposioValidationOptions {
  allowSideEffect?: boolean;
}

export interface PolicyToolCall {
  name: string;
  args?: unknown;
  blocked?: boolean;
}

export interface BrowserOpenPolicyInput {
  toolName: string;
  args?: unknown;
  priorToolCalls?: PolicyToolCall[];
  userMessage?: string;
  /** Backward-compatible route-test alias. New callers should use args. */
  toolArgs?: unknown;
  /** Backward-compatible route-test alias. New callers should use priorToolCalls. */
  priorToolCallsInRun?: PolicyToolCall[];
}

export interface BrowserOpenPolicyResult {
  block: boolean;
  reason?: string;
}

const DIRECT_SEND_BLOCKLIST = new Set(['GMAIL_SEND_EMAIL']);
const USER_BROWSER_KEYWORDS =
  /(browser|web\s*browser|open\s+the\s+browser|use\s+browser|browserbase|vnc|takeover|human\s+takeover|网页|网站|浏览|打开浏览器|用浏览器|浏览器|接管)/i;

export function classifyComposioToolSlug(slug: string): ComposioToolClassification {
  const normalized = slug.trim().toUpperCase();
  if (!normalized) {
    return { kind: 'unknown', reason: 'empty tool slug' };
  }

  if (DIRECT_SEND_BLOCKLIST.has(normalized)) {
    return {
      kind: 'blocked',
      verb: 'SEND',
      reason: `${normalized} is a direct side effect and is not allowed directly; create a draft, review it, then send the draft.`,
    };
  }

  const parts = normalized.split(/[^A-Z0-9]+/).filter(Boolean);
  const dangerousVerb = parts.find((part) => COMPOSIO_DANGEROUS_WRITE_VERBS.has(part));
  if (dangerousVerb) {
    return { kind: 'dangerous_write', verb: dangerousVerb };
  }

  const safeWriteVerb = parts.find((part) => COMPOSIO_SAFE_WRITE_VERBS.has(part));
  if (safeWriteVerb) {
    return { kind: 'safe_write', verb: safeWriteVerb };
  }

  const readVerb = parts.find((part) => COMPOSIO_READ_VERBS.has(part));
  if (readVerb) {
    return { kind: 'read', verb: readVerb };
  }

  return {
    kind: 'unknown',
    reason: `tool slug "${slug}" does not expose a recognized read or write verb`,
  };
}

export function validateComposioExecTool(
  slug: string,
  options: ComposioValidationOptions = {},
): string | null {
  const classification = classifyComposioToolSlug(slug);

  if (classification.kind === 'read') {
    return null;
  }

  if (classification.kind === 'safe_write') {
    if (options.allowSideEffect) {
      return null;
    }
    return `Composio tool ${slug} is a write action (${classification.verb}) and requires --allow-side-effect true.`;
  }

  if (classification.kind === 'dangerous_write') {
    return `Composio tool ${slug} is a dangerous write action (${classification.verb}) and is blocked until stronger confirmation exists.`;
  }

  if (classification.kind === 'blocked') {
    return classification.reason;
  }

  return `Composio tool ${slug} is not clearly read/query-only. Unknown verbs are rejected by execution policy.`;
}

export function isPinGroundingCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) {
    return false;
  }

  return (
    /^pin\s+(raw|signals|memory|profile|cards|feedback|world)\b/i.test(trimmed) ||
    /^pin\s+personal\s+exec\b/i.test(trimmed) ||
    /^pin\s+web\s+fetch\b/i.test(trimmed)
  );
}

export function extractHost(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function getStringField(value: unknown, field: string): string | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === 'string' ? candidate : null;
}

function extractUrlFromPinWebFetch(command: string): string | null {
  if (!/\bpin\s+web\s+fetch\b/i.test(command)) {
    return null;
  }
  const flagged = command.match(/--url(?:=|\s+)(["']?)([^\s"']+)\1/i);
  if (flagged) {
    return flagged[2];
  }
  const positional = command.match(/\bpin\s+web\s+fetch\s+(\S+)/i);
  if (positional && !positional[1].startsWith('--')) {
    return positional[1];
  }
  return null;
}

export function extractWebReadHost(call: PolicyToolCall): string | null {
  if (call.name === 'read_web') {
    const url = getStringField(call.args, 'url');
    return url ? extractHost(url) : null;
  }

  if (call.name === 'exec') {
    const command = getStringField(call.args, 'command');
    const url = command ? extractUrlFromPinWebFetch(command) : null;
    return url ? extractHost(url) : null;
  }

  return null;
}

export function shouldBlockBrowserOpen(input: BrowserOpenPolicyInput): BrowserOpenPolicyResult {
  if (input.toolName !== 'browser') {
    return { block: false };
  }

  const args = input.args ?? input.toolArgs;
  const action = getStringField(args, 'action');
  if (action !== 'open') {
    return { block: false };
  }

  const priorCalls = input.priorToolCalls ?? input.priorToolCallsInRun ?? [];
  if (priorCalls.some((call) => call.name === 'browser')) {
    return { block: false };
  }

  if (input.userMessage && USER_BROWSER_KEYWORDS.test(input.userMessage)) {
    return { block: false };
  }

  const browserUrl = getStringField(args, 'url');
  const browserHost = browserUrl ? extractHost(browserUrl) : null;
  const priorGrounding = priorCalls.some((call) => {
    if (call.name === 'read_web') {
      return true;
    }
    if (call.name !== 'exec') {
      return false;
    }
    const command = getStringField(call.args, 'command');
    return command ? isPinGroundingCommand(command) : false;
  });

  if (!priorGrounding) {
    return {
      block: true,
      reason:
        'Browser.open is Tier 4 / last-resort. Read local Pin context first (pin raw/signals/memory/profile/cards or personal exec), or use read_web for URL reading before opening a browser.',
    };
  }

  if (browserUrl && /^https:\/\//i.test(browserUrl) && browserHost) {
    const hasSameHostWebRead = priorCalls.some((call) => extractWebReadHost(call) === browserHost);
    if (!hasSameHostWebRead) {
      return {
        block: true,
        reason: `Tier 4 two-step first step: read ${browserHost} FIRST with read_web(url, intent) before Browser.open. read_web uses the pin web fetch safety path and upgrades to browser automatically when fetch is insufficient.`,
      };
    }
  }

  return { block: false };
}

export function renderToolDecisionPolicyBlock(): string {
  return [
    'Tool decision policy (single source of truth):',
    '- Tier 1 - Local read: answer from conversation/card context when enough, otherwise use pin raw, pin signals, pin memory, pin profile, pin cards, pin feedback, pin world.',
    '- Tier 2 - Composio read: use pin personal exec for connected personal data. Composio read verbs are allowed by default: GET, FETCH, SEARCH, LIST, READ, QUERY, LOOKUP, RETRIEVE, FIND.',
    '- Tier 3 - Composio write: SEND, CREATE, POST, UPDATE, REPLY, DRAFT, SCHEDULE, PUBLISH, UPLOAD, ADD, INSERT, PATCH, SUBMIT, FORWARD, INVITE require explicit --allow-side-effect=true. Draft first, show the user, wait for OK/confirm, then execute exactly one approved action.',
    '- Dangerous writes are blocked for now: DELETE, REMOVE, CANCEL, TRANSFER, CHARGE, PAY, PURCHASE, ARCHIVE, MOVE, EXECUTE, RUN.',
    '- GMAIL_SEND_EMAIL is always blocked. Use GMAIL_CREATE_EMAIL_DRAFT, let the user review, then GMAIL_SEND_DRAFT only with explicit approval.',
    '- Tier 4 - Browser/read_web LAST-RESORT: use read_web(url, intent) for web pages. This is the two-step web path: Step 1 read_web fetches first through the pin web fetch safety path; EVERY https URL starts here. Step 2 upgrades to Browser.open only when fetch is blocked, too sparse, or clearly an SPA/login wall / 401 / 403 / JS-only shell.',
    '- Cite the specific fetch failure/evidence when read_web upgrades. Do not open browser on a hunch.',
    '- Browser.open is last-resort and must not be the first tool unless the user explicitly asks for a browser/takeover flow.',
    '- NEVER use browser for Gmail / GCal / Slack / Notion / GitHub data when Pin CLI or Composio can read it.',
    '- CLI fallback: pin web fetch remains available when read_web is unavailable, but the agent should prefer read_web.',
  ].join('\n');
}

export function renderRoutingExamplesBlock(): string {
  return [
    'Routing examples:',
    '- user asks "what is new today?" / "any fresh signals?" -> pin signals recent --status open --limit 30. NOT browser.',
    '- user asks "what meetings today?" -> pin raw gcal today. NOT browser.',
    '- user asks "did Sarah email me last week?" -> pin raw gmail recent --hours 168. If missing, use Tier 3 read: pin personal exec --tool GMAIL_FETCH_EMAILS.',
    '- user asks "summarize this article: <url>" -> read_web(url, intent). NOT browser.',
    '- user asks about a public store / promo / sale / pricing / docs page -> read_web(url, intent) first. Browser is only an automatic upgrade when fetch is insufficient.',
    '- user asks "open <url>" without saying "browser" -> read_web(url, intent) first through the pin web fetch path; Browser.open is the second step, not the first.',
    '- user asks "schedule 1on1 with Sarah Wed 3pm" -> first pin raw gcal week, draft event details in chat, wait for user OK, then pin personal exec --tool GOOGLECALENDAR_CREATE_EVENT --allow-side-effect=true.',
    '- user asks "send Andy a Slack with the launch link" -> ground via pin raw slack or memory, draft message in chat, wait for user OK, then pin personal exec --tool SLACK_SEND_MESSAGE --allow-side-effect=true.',
    '- user explicitly says "open browser to <site>" / "navigate to <url>" -> Browser.open is OK because the user directed the browser flow.',
  ].join('\n');
}

export function renderSideEffectRulesBlock(): string {
  return [
    'Side-effect rules:',
    '- Read/query Composio tools are allowed by default.',
    '- Safe writes require --allow-side-effect=true and explicit user intent.',
    '- Recognized write verbs include SEND, CREATE, POST, UPDATE. DELETE, TRANSFER, CHARGE and other dangerous verbs are blocked until a stronger approval path exists; stop and ask the user explicitly instead of proceeding.',
    '- Unknown Composio verbs are rejected.',
    '- Never call GMAIL_SEND_EMAIL directly; use GMAIL_CREATE_EMAIL_DRAFT -> user review -> GMAIL_SEND_DRAFT.',
    '- One OK covers exactly one outbound write. Draft and confirm this action again if the details change.',
  ].join('\n');
}

export function renderBrowserLastResortDescription(): string {
  return [
    'Last-resort browser tool. Prefer read_web(url, intent) for web pages; it fetches first and upgrades to browser automatically when needed.',
    'Before using Browser.open directly, ground with Pin CLI context or read_web unless the user explicitly asked for browser control.',
  ].join(' ');
}
