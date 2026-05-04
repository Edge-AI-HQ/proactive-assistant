import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { FetchError, fetchUrl, type FetchResult } from '../cli/web.js';
import { getBrowserManager } from './tool.js';
import { VIEWPORT_PRESETS } from './types.js';

export interface ReadWebFetchOutcome {
  upgrade: boolean;
  reason?: string;
}

export interface ReadWebResult {
  mode: 'fetch' | 'browser';
  upgraded: boolean;
  upgradeReason?: string;
  url: string;
  finalUrl?: string;
  status?: number;
  contentType?: string;
  byteCount?: number;
  truncated?: boolean;
  title?: string | null;
  text: string;
}

export interface ExecuteReadWebOptions {
  sessionKey: string;
  url: string;
  intent?: string;
  fetchUrlImpl?: (opts: { url: string; maxBytes?: number; timeoutMs?: number }) => Promise<FetchResult>;
  openBrowserImpl?: (url: string, intent?: string) => Promise<string>;
}

const MIN_USEFUL_TEXT_CHARS = 500;
const SPARSE_PAGE_PATTERNS = [
  /\bloading\b/i,
  /\benable\s+javascript\b/i,
  /\bplease\s+enable\s+javascript\b/i,
  /\bapp\s+is\s+loading\b/i,
  /\bspinner\b/i,
  /\broot\b/i,
];

export function classifyReadWebFetchOutcome(result: FetchResult): ReadWebFetchOutcome {
  const text = result.text.trim();
  if (!text) {
    return { upgrade: true, reason: 'fetch returned empty text; likely SPA shell or blocked page' };
  }

  if (text.length < MIN_USEFUL_TEXT_CHARS && SPARSE_PAGE_PATTERNS.some((pattern) => pattern.test(text))) {
    return { upgrade: true, reason: 'fetch returned sparse SPA-like content' };
  }

  if (result.byteCount < 200 && text.length < MIN_USEFUL_TEXT_CHARS) {
    return { upgrade: true, reason: 'fetch returned sparse content' };
  }

  return { upgrade: false };
}

function shouldUpgradeFetchError(err: unknown): { upgrade: boolean; reason: string } {
  const code = typeof (err as { code?: unknown })?.code === 'string' ? String((err as { code?: unknown }).code) : null;
  const message = err instanceof Error ? err.message : String(err);
  const normalized = message.toLowerCase();

  if (code === 'invalid_url' || code === 'scheme_blocked' || code === 'ssrf_blocked') {
    return { upgrade: false, reason: message };
  }

  if (
    code === 'http_error' ||
    normalized.includes('401') ||
    normalized.includes('403') ||
    normalized.includes('login') ||
    normalized.includes('auth') ||
    normalized.includes('forbidden') ||
    normalized.includes('unauthorized')
  ) {
    return { upgrade: true, reason: `fetch hit login/auth barrier or HTTP block: ${message}` };
  }

  if (code === 'content_type_blocked') {
    return { upgrade: false, reason: message };
  }

  return { upgrade: true, reason: `fetch was insufficient: ${message}` };
}

export async function executeReadWeb(options: ExecuteReadWebOptions): Promise<ReadWebResult> {
  const fetchImpl = options.fetchUrlImpl ?? fetchUrl;
  const openBrowser = options.openBrowserImpl;

  try {
    const fetched = await fetchImpl({ url: options.url });
    const outcome = classifyReadWebFetchOutcome(fetched);
    if (!outcome.upgrade) {
      return {
        mode: 'fetch',
        upgraded: false,
        url: fetched.url,
        finalUrl: fetched.finalUrl,
        status: fetched.status,
        contentType: fetched.contentType,
        byteCount: fetched.byteCount,
        truncated: fetched.truncated,
        title: fetched.title,
        text: fetched.text,
      };
    }

    if (!openBrowser) {
      return {
        mode: 'fetch',
        upgraded: false,
        upgradeReason: outcome.reason,
        url: fetched.url,
        finalUrl: fetched.finalUrl,
        status: fetched.status,
        contentType: fetched.contentType,
        byteCount: fetched.byteCount,
        truncated: fetched.truncated,
        title: fetched.title,
        text: fetched.text,
      };
    }

    const browserText = await openBrowser(options.url, options.intent);
    return {
      mode: 'browser',
      upgraded: true,
      upgradeReason: outcome.reason,
      url: options.url,
      text: browserText,
    };
  } catch (err) {
    const outcome = shouldUpgradeFetchError(err);
    if (!outcome.upgrade) {
      throw err;
    }

    if (!openBrowser) {
      if (err instanceof FetchError) {
        throw err;
      }
      throw new Error(outcome.reason);
    }

    const browserText = await openBrowser(options.url, options.intent);
    return {
      mode: 'browser',
      upgraded: true,
      upgradeReason: outcome.reason,
      url: options.url,
      text: browserText,
    };
  }
}

function formatReadWebResult(result: ReadWebResult): string {
  return JSON.stringify(result, null, 2);
}

export function registerReadWebTool(api: OpenClawPluginApi): void {
  api.registerTool((ctx: { sessionKey?: string }) => ({
    name: 'read_web',
    description: [
      'Read a public web URL. This is the preferred Tier 4 web-reading tool.',
      'It first uses the safe pin web fetch path (HTTPS only, SSRF checks, content-type checks).',
      'If fetch is blocked, too sparse, or looks like a login wall / SPA shell, it upgrades to Browser.open and returns the first browser snapshot.',
      'Use Browser.open directly only for explicit browser-control tasks or after read_web proves browser is needed.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Fully-qualified https:// URL to read.' },
        intent: { type: 'string', description: 'Short reason for reading the page.' },
      },
      required: ['url'],
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>) => {
      const url = typeof args.url === 'string' ? args.url.trim() : '';
      if (!url) {
        return 'Error: "url" is required.';
      }
      const intent = typeof args.intent === 'string' ? args.intent : undefined;
      const sessionKey = ctx.sessionKey ?? 'unknown';

      const result = await executeReadWeb({
        sessionKey,
        url,
        intent,
        openBrowserImpl: async (targetUrl) => {
          const mgr = getBrowserManager(api);
          const session = await mgr.createSession({
            subagentId: sessionKey,
            url: targetUrl,
            viewport: VIEWPORT_PRESETS.desktop,
          });
          const snapshot = await mgr.snapshot(session.id);
          return `Browser opened at ${targetUrl}. User can see the live view.\n\n${snapshot}`;
        },
      });

      return formatReadWebResult(result);
    },
  }));
}
