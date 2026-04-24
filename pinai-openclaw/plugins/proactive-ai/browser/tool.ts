/**
 * Browser tool for OpenClaw subagents — Browserbase backend.
 *
 * Snapshot-first workflow:
 *   open → snapshot → click(ref) / type(ref) / ... → snapshot again
 *
 * Every interactive action returns a fresh accessibility snapshot so the
 * agent always has up-to-date refs without an extra round trip.
 */
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { BrowserbaseManager } from './manager.js';
import { VIEWPORT_PRESETS, type ViewportPreset } from './types.js';
import { assertBrowserToolAllowed } from './control-state.js';

let manager: BrowserbaseManager | null = null;

function getManager(api: OpenClawPluginApi): BrowserbaseManager {
  if (!manager) {
    manager = new BrowserbaseManager({
      info: (msg) => api.logger.info(msg),
      warn: (msg) => api.logger.warn(msg),
      error: (msg) => api.logger.error(msg),
    });
  }
  return manager;
}

export function getSharedBrowserManager(): BrowserbaseManager | null {
  return manager;
}

function resolveViewport(
  input: unknown,
): ViewportPreset | { width: number; height: number } | undefined {
  if (typeof input === 'string') {
    if (input === 'mobile' || input === 'desktop') return input;
    return undefined;
  }
  if (input && typeof input === 'object') {
    const v = input as { width?: unknown; height?: unknown };
    if (typeof v.width === 'number' && typeof v.height === 'number') {
      return { width: v.width, height: v.height };
    }
  }
  return undefined;
}

export function registerBrowserTool(api: OpenClawPluginApi): void {
  api.registerTool((ctx: { sessionKey?: string }) => ({
    name: 'browser',
    description: [
      'Control a web browser. The user can see what you do live.',
      'One browser per conversation with a single tab.',
      '',
      'IMPORTANT — Snapshot-first workflow:',
      '  1. Call "open" with a URL to start. It returns an accessibility snapshot.',
      '  2. Use refs (e.g. "e3") from the snapshot when calling "click" / "type" / "select" / "wait".',
      '  3. Every action returns a FRESH snapshot — use those new refs for the next step.',
      '  4. Old refs from a previous snapshot are invalid. Never reuse them.',
      '',
      'Actions:',
      '  open             — Open browser at URL. Must be called first. Returns snapshot.',
      '  snapshot         — Re-read page structure (use if you are unsure state is fresh).',
      '  click            — Click element by ref. Returns new snapshot.',
      '  type             — Type into element by ref. Default replaces existing value.',
      '  press_key        — Press a key: Enter, Tab, Escape, ArrowDown, PageDown, Backspace, etc.',
      '  select           — Pick value(s) in a <select> element by ref.',
      '  wait             — Wait for element/state/URL change. Returns snapshot once met.',
      '  scroll           — Page scroll by deltaY (positive=down). Returns new snapshot.',
      '  scroll_to        — Scroll a specific element (by ref) into view.',
      '  navigate         — Go to a different URL. Returns new snapshot.',
      '  go_back          — Browser history back. Returns new snapshot.',
      '  go_forward       — Browser history forward. Returns new snapshot.',
      '  reload           — Reload the current page. Returns new snapshot.',
      '  get_text         — Return the trimmed text content of an element by ref. Use for',
      '                     OTP codes, order numbers, confirmation info — NOT for generic',
      '                     page reading (use snapshot for that).',
      '  upload_file      — Attach a file at `path` to a file-input element by ref.',
      '  set_viewport     — Switch between "mobile" (390×844) and "desktop" (1280×800).',
      '  screenshot       — Capture an image of the current page (visual fallback).',
      '  request_takeover — Hand the browser to the user with a reason. Use when you hit',
      '                     captcha, 2FA, SMS verification, or any step you can\'t do.',
      '                     After calling this, STOP using browser tools and wait for',
      '                     the user\'s next message before continuing.',
      '  new_tab          — Open a new tab at `url` and switch to it. Refs reset.',
      '  switch_tab       — Switch active tab by `tabIndex` (from list_tabs). Refs reset.',
      '  close_tab        — Close tab at `tabIndex`. Cannot close the last tab.',
      '  list_tabs        — List all open tabs ({index, url, title, active}).',
      '  handle_dialog    — Arm a one-shot handler for the NEXT native dialog before you',
      '                     trigger it. `policy`: "accept" or "dismiss". For prompt()',
      '                     with accept, set `text` to the value to enter.',
      '  download         — Click element by `ref` to trigger a download; save to `path`.',
      '                     Returns { path, suggestedFilename }.',
      '  console          — Return recent browser console messages (JS errors / warnings).',
      '                     Use when the page behaves unexpectedly.',
      '  close            — Close the browser when finished.',
      '',
      'Tips:',
      '  • Snapshot entries look like: button "Sign in" [ref=e3]. Pick by role + name.',
      '  • After submitting a form (Enter or click), use "wait" with urlContains or state=visible.',
      '  • When a page looks empty, scroll down or wait — content may still be loading.',
      '  • If a click or type fails because the ref is stale, call snapshot and retry with the new ref.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'open', 'snapshot', 'click', 'type', 'press_key',
            'select', 'wait', 'scroll', 'scroll_to', 'navigate',
            'go_back', 'go_forward', 'reload', 'get_text', 'upload_file',
            'set_viewport', 'screenshot', 'request_takeover',
            'new_tab', 'switch_tab', 'close_tab', 'list_tabs',
            'handle_dialog', 'download', 'console', 'close',
          ],
          description: 'The browser action to perform.',
        },
        url: { type: 'string', description: 'URL for "open" and "navigate".' },
        ref: { type: 'string', description: 'Element ref from latest snapshot (e.g. "e3"). Required for click/type/select, optional for wait.' },
        text: { type: 'string', description: 'Text to type for "type" action.' },
        clear: { type: 'boolean', description: 'For "type": true (default) replaces existing value; false types key-by-key at current selection.' },
        key: { type: 'string', description: 'Key name for "press_key": Enter / Tab / Escape / ArrowDown / ArrowUp / PageDown / PageUp / Backspace / Delete / Home / End / or any single character.' },
        value: { description: 'For "select": option value (string or array of strings for multi-select).' },
        state: {
          type: 'string',
          enum: ['visible', 'hidden', 'attached', 'detached'],
          description: 'For "wait" with ref: element state to wait for. Default "visible".',
        },
        urlContains: { type: 'string', description: 'For "wait": wait until the URL contains this substring.' },
        timeoutMs: { type: 'number', description: 'For "wait": max wait in ms (default 10000).' },
        deltaY: { type: 'number', description: 'For "scroll": scroll amount in pixels. Positive = down.' },
        viewport: {
          description: 'For "set_viewport" and "open": "mobile" / "desktop" preset, or { width, height } object.',
        },
        reason: {
          type: 'string',
          description: 'For "request_takeover": short description of why you need the user to help (shown in the UI). Example: "I need you to complete the 2FA SMS verification".',
        },
        path: {
          type: 'string',
          description: 'For "upload_file" / "download": container path. Download saves to this path, upload reads from it. Recommend under /app/.openclaw/workspace/.',
        },
        tabIndex: {
          type: 'number',
          description: 'For "switch_tab" / "close_tab": the tab index from list_tabs.',
        },
        policy: {
          type: 'string',
          enum: ['accept', 'dismiss'],
          description: 'For "handle_dialog": how to respond to the next native dialog.',
        },
      },
      required: ['action'],
    },

    execute: async (_toolCallId: string, args: Record<string, unknown>) => {
      const mgr = getManager(api);
      const chatKey = ctx.sessionKey ?? 'unknown';
      const action = String(args.action ?? '');
      api.logger.info(`[browser-tool] action=${action} sessionKey=${chatKey}`);

      const asString = (v: unknown): string | undefined =>
        typeof v === 'string' && v.length > 0 ? v : undefined;
      const asNumber = (v: unknown): number | undefined =>
        typeof v === 'number' && Number.isFinite(v) ? v : undefined;

      try {
        switch (action) {
          case 'open': {
            const url = asString(args.url);
            if (!url) return 'Error: "url" is required for the "open" action.';
            const vp = resolveViewport(args.viewport);
            const viewportSize = typeof vp === 'string' ? VIEWPORT_PRESETS[vp] : vp ?? VIEWPORT_PRESETS.mobile;
            // open always produces a fresh browser. If the agent wants to
            // change URL inside the current browser, it should use "navigate".
            // Calling open on top of an existing session destroys the old one
            // first so the frontend receives browser:closed → browser:opened
            // in order and any silently-dead Browserbase sessions get cleared.
            const existing = mgr.getSessionBySubagent(chatKey);
            if (existing) {
              assertBrowserToolAllowed(existing, 'open');
              await mgr.destroySession(existing.id);
            }
            const session = await mgr.createSession({ subagentId: chatKey, url, viewport: viewportSize });
            const snapshot = await mgr.snapshot(session.id);
            return `Browser opened at ${url}. User can see the live view.\n\n${snapshot}`;
          }

          case 'navigate': {
            const url = asString(args.url);
            if (!url) return 'Error: "url" is required for "navigate".';
            const session = mgr.getSessionBySubagent(chatKey);
            if (!session) return 'Error: No browser session. Call "open" first.';
            const result = await mgr.navigate(session.id, url);
            return `Navigated to ${url} (title: ${result.title})\n\n${result.snapshot}`;
          }

          case 'snapshot': {
            const session = mgr.getSessionBySubagent(chatKey);
            if (!session) return 'Error: No browser session. Call "open" first.';
            return mgr.snapshot(session.id);
          }

          case 'click': {
            const ref = asString(args.ref);
            if (!ref) return 'Error: "ref" required for "click" (e.g. "e3" from latest snapshot).';
            const session = mgr.getSessionBySubagent(chatKey);
            if (!session) return 'Error: No browser session. Call "open" first.';
            return `Clicked ${ref}.\n\n${await mgr.clickRef(session.id, ref)}`;
          }

          case 'type': {
            const ref = asString(args.ref);
            const text = asString(args.text);
            if (!ref || text === undefined) return 'Error: "ref" and "text" required for "type".';
            const clear = args.clear !== false;
            const session = mgr.getSessionBySubagent(chatKey);
            if (!session) return 'Error: No browser session. Call "open" first.';
            return `Typed into ${ref} (clear=${clear}).\n\n${await mgr.typeRef(session.id, ref, text, { clear })}`;
          }

          case 'press_key': {
            const key = asString(args.key);
            if (!key) return 'Error: "key" required for "press_key".';
            const session = mgr.getSessionBySubagent(chatKey);
            if (!session) return 'Error: No browser session. Call "open" first.';
            return `Pressed ${key}.\n\n${await mgr.pressKey(session.id, key)}`;
          }

          case 'select': {
            const ref = asString(args.ref);
            const value = args.value;
            if (!ref || value === undefined) return 'Error: "ref" and "value" required for "select".';
            if (typeof value !== 'string' && !(Array.isArray(value) && value.every(v => typeof v === 'string'))) {
              return 'Error: "value" must be a string or array of strings.';
            }
            const session = mgr.getSessionBySubagent(chatKey);
            if (!session) return 'Error: No browser session. Call "open" first.';
            return `Selected in ${ref}.\n\n${await mgr.selectOption(session.id, ref, value)}`;
          }

          case 'wait': {
            const session = mgr.getSessionBySubagent(chatKey);
            if (!session) return 'Error: No browser session. Call "open" first.';
            const opts = {
              ref: asString(args.ref),
              state: asString(args.state) as 'visible' | 'hidden' | 'attached' | 'detached' | undefined,
              urlContains: asString(args.urlContains),
              timeoutMs: asNumber(args.timeoutMs),
            };
            return `Wait completed.\n\n${await mgr.waitFor(session.id, opts)}`;
          }

          case 'scroll': {
            const session = mgr.getSessionBySubagent(chatKey);
            if (!session) return 'Error: No browser session. Call "open" first.';
            const deltaY = asNumber(args.deltaY) ?? 400;
            return `Scrolled by ${deltaY}px.\n\n${await mgr.scroll(session.id, deltaY)}`;
          }

          case 'set_viewport': {
            const session = mgr.getSessionBySubagent(chatKey);
            if (!session) return 'Error: No browser session. Call "open" first.';
            const vp = resolveViewport(args.viewport);
            if (!vp) return 'Error: "viewport" must be "mobile", "desktop", or { width, height }.';
            const snapshot = await mgr.setViewport(session.id, vp);
            const label = typeof vp === 'string' ? vp : `${vp.width}×${vp.height}`;
            return `Viewport set to ${label}.\n\n${snapshot}`;
          }

          case 'screenshot': {
            const session = mgr.getSessionBySubagent(chatKey);
            if (!session) return 'Error: No browser session. Call "open" first.';
            const buf = await mgr.screenshot(session.id);
            return `Screenshot captured (${Math.round(buf.length / 1024)} KB JPEG). Note: the image is not returned to chat in this flow — use "snapshot" for text-based page reading.`;
          }

          case 'scroll_to': {
            const ref = asString(args.ref);
            if (!ref) return 'Error: "ref" required for "scroll_to".';
            const session = mgr.getSessionBySubagent(chatKey);
            if (!session) return 'Error: No browser session. Call "open" first.';
            return `Scrolled ${ref} into view.\n\n${await mgr.scrollToRef(session.id, ref)}`;
          }

          case 'go_back': {
            const session = mgr.getSessionBySubagent(chatKey);
            if (!session) return 'Error: No browser session. Call "open" first.';
            return `Went back.\n\n${await mgr.goBack(session.id)}`;
          }

          case 'go_forward': {
            const session = mgr.getSessionBySubagent(chatKey);
            if (!session) return 'Error: No browser session. Call "open" first.';
            return `Went forward.\n\n${await mgr.goForward(session.id)}`;
          }

          case 'reload': {
            const session = mgr.getSessionBySubagent(chatKey);
            if (!session) return 'Error: No browser session. Call "open" first.';
            return `Reloaded.\n\n${await mgr.reload(session.id)}`;
          }

          case 'get_text': {
            const ref = asString(args.ref);
            if (!ref) return 'Error: "ref" required for "get_text".';
            const session = mgr.getSessionBySubagent(chatKey);
            if (!session) return 'Error: No browser session. Call "open" first.';
            const text = await mgr.getText(session.id, ref);
            return text ? `Text of ${ref}: ${text}` : `(${ref} has no text content)`;
          }

          case 'upload_file': {
            const ref = asString(args.ref);
            const path = asString(args.path);
            if (!ref || !path) return 'Error: "ref" and "path" required for "upload_file".';
            const session = mgr.getSessionBySubagent(chatKey);
            if (!session) return 'Error: No browser session. Call "open" first.';
            return `Attached ${path} to ${ref}.\n\n${await mgr.uploadFile(session.id, ref, path)}`;
          }

          case 'request_takeover': {
            const session = mgr.getSessionBySubagent(chatKey);
            if (!session) return 'Error: No browser session. Call "open" first.';
            const reason = asString(args.reason) ?? 'I need your help here';
            mgr.requestUserTakeover(session.id, reason);
            return (
              `Takeover requested. Reason: ${reason}\n\n` +
              'The user is now in control of the browser. DO NOT call any more ' +
              'browser tools. Reply with a short message telling the user what ' +
              'you need from them, then stop and wait for their next message. ' +
              'When they indicate they are done, call "snapshot" to see the ' +
              'updated page and resume.'
            );
          }

          case 'new_tab': {
            const session = mgr.getSessionBySubagent(chatKey);
            if (!session) return 'Error: No browser session. Call "open" first.';
            const url = asString(args.url);
            return `Opened new tab${url ? ` at ${url}` : ''}.\n\n${await mgr.newTab(session.id, url)}`;
          }

          case 'switch_tab': {
            const session = mgr.getSessionBySubagent(chatKey);
            if (!session) return 'Error: No browser session. Call "open" first.';
            const idx = asNumber(args.tabIndex);
            if (idx === undefined) return 'Error: "tabIndex" required for "switch_tab".';
            return `Switched to tab ${idx}.\n\n${await mgr.switchTab(session.id, idx)}`;
          }

          case 'close_tab': {
            const session = mgr.getSessionBySubagent(chatKey);
            if (!session) return 'Error: No browser session. Call "open" first.';
            const idx = asNumber(args.tabIndex);
            if (idx === undefined) return 'Error: "tabIndex" required for "close_tab".';
            return `Closed tab ${idx}.\n\n${await mgr.closeTab(session.id, idx)}`;
          }

          case 'list_tabs': {
            const session = mgr.getSessionBySubagent(chatKey);
            if (!session) return 'Error: No browser session. Call "open" first.';
            const tabs = await mgr.listTabs(session.id);
            if (tabs.length === 0) return 'No tabs open.';
            return tabs
              .map((t) => `[${t.index}${t.active ? '*' : ''}] ${t.title || '(untitled)'} — ${t.url}`)
              .join('\n') + '\n\n(* = active tab)';
          }

          case 'handle_dialog': {
            const session = mgr.getSessionBySubagent(chatKey);
            if (!session) return 'Error: No browser session. Call "open" first.';
            const policy = asString(args.policy);
            if (policy !== 'accept' && policy !== 'dismiss') {
              return 'Error: "policy" must be "accept" or "dismiss".';
            }
            const promptText = asString(args.text);
            mgr.armDialog(session.id, policy, promptText);
            return `Armed dialog handler: next dialog will be ${policy}${promptText ? ` with text "${promptText}"` : ''}. Trigger the action that shows the dialog now.`;
          }

          case 'download': {
            const session = mgr.getSessionBySubagent(chatKey);
            if (!session) return 'Error: No browser session. Call "open" first.';
            const ref = asString(args.ref);
            const savePath = asString(args.path);
            if (!ref || !savePath) return 'Error: "ref" (trigger element) and "path" (save location) required for "download".';
            const result = await mgr.downloadFile(session.id, ref, savePath);
            return `Downloaded to ${result.path} (original filename: ${result.suggestedFilename}).`;
          }

          case 'console': {
            const session = mgr.getSessionBySubagent(chatKey);
            if (!session) return 'Error: No browser session. Call "open" first.';
            const limit = asNumber(args.timeoutMs) ?? 50;
            const entries = mgr.getConsoleLogs(session.id, limit);
            if (entries.length === 0) return 'No console messages yet.';
            return entries
              .map((e) => `[${new Date(e.at).toISOString()}] ${e.level.toUpperCase()} (tab ${e.tabIndex}): ${e.text}`)
              .join('\n');
          }

          case 'close': {
            const session = mgr.getSessionBySubagent(chatKey);
            if (!session) return 'Browser session already closed.';
            assertBrowserToolAllowed(session, 'close');
            await mgr.destroySession(session.id);
            return 'Browser closed.';
          }

          default:
            return `Error: Unknown action "${action}". Valid: open, snapshot, click, type, press_key, select, wait, scroll, navigate, set_viewport, screenshot, close.`;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        api.logger.error(`[browser-tool] ${action} failed: ${msg}`);
        return `Error: ${msg}`;
      }
    },
  }));

  api.logger.info('[browser-tool] Registered browser tool (Browserbase backend, snapshot-first)');
}
