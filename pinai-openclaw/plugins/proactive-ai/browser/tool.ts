/**
 * Browser tool for OpenClaw subagents — Browserbase backend.
 *
 * Pure caller of BrowserbaseManager. Does NOT emit events —
 * all lifecycle events are owned by the manager.
 */
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { BrowserbaseManager } from './manager.js';

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

export function registerBrowserTool(api: OpenClawPluginApi): void {
  api.registerTool((ctx: { sessionKey?: string }) => ({
    name: 'browser',
    description: [
      'Open and control a web browser. The user can see what you do in real-time.',
      'One browser per conversation; supports multiple tabs.',
      'Actions:',
      '  open      — Open browser at a URL (or reuse existing). Must be called first.',
      '  navigate  — Go to a different URL in the active tab.',
      '  click     — Click at (x, y) coordinates.',
      '  type      — Type text into the focused element.',
      '  scroll    — Scroll the page (deltaY positive = down).',
      '  new_tab   — Open a new tab (optionally at a URL).',
      '  switch_tab — Switch to a different tab by tabIndex.',
      '  close_tab — Close a specific tab by tabIndex.',
      '  list_tabs — List all open tabs.',
      '  close     — Close the entire browser when done.',
      '',
      'After "open", the user sees the browser in their app and can take over control.',
      'Always call "close" when the task is finished.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['open', 'navigate', 'click', 'type', 'scroll', 'new_tab', 'switch_tab', 'close_tab', 'list_tabs', 'close'],
          description: 'The browser action to perform.',
        },
        url: { type: 'string', description: 'URL for "open", "navigate", and "new_tab".' },
        x: { type: 'number', description: 'X coordinate for "click".' },
        y: { type: 'number', description: 'Y coordinate for "click".' },
        text: { type: 'string', description: 'Text for "type" action.' },
        deltaY: { type: 'number', description: 'Scroll amount. Positive = down.' },
        tabIndex: { type: 'number', description: 'Tab index for "switch_tab" and "close_tab".' },
      },
      required: ['action'],
    },

    execute: async (_toolCallId: string, args: Record<string, any>) => {
      const { action, url, x, y, text, deltaY, tabIndex } = args;
      const mgr = getManager(api);
      const chatKey = ctx.sessionKey ?? 'unknown';
      api.logger.info(`[browser-tool] action=${action} sessionKey=${chatKey}`);

      try {
        switch (action) {
          case 'open': {
            if (!url) return 'Error: "url" is required for the "open" action.';
            const existing = mgr.getSessionBySubagent(chatKey);
            if (existing) {
              const result = await mgr.navigate(existing.id, url);
              return `Browser navigated to ${url} (title: ${result.title})`;
            }
            const session = await mgr.createSession({ subagentId: chatKey, url, viewport: { width: 390, height: 844 } });
            return `Browser opened at ${url}. The user can see it now. Session ID: ${session.id}`;
          }
          case 'navigate': {
            if (!url) return 'Error: "url" is required for "navigate".';
            const session = mgr.getSessionBySubagent(chatKey);
            if (!session) return 'Error: No browser session. Call "open" first.';
            const result = await mgr.navigate(session.id, url);
            return `Navigated to ${url} (title: ${result.title})`;
          }
          case 'click': {
            if (x == null || y == null) return 'Error: "x" and "y" required for "click".';
            const session = mgr.getSessionBySubagent(chatKey);
            if (!session) return 'Error: No browser session. Call "open" first.';
            await mgr.click(session.id, x, y);
            return `Clicked at (${x}, ${y})`;
          }
          case 'type': {
            if (!text) return 'Error: "text" required for "type".';
            const session = mgr.getSessionBySubagent(chatKey);
            if (!session) return 'Error: No browser session. Call "open" first.';
            await mgr.type(session.id, text);
            return `Typed "${text}"`;
          }
          case 'scroll': {
            const session = mgr.getSessionBySubagent(chatKey);
            if (!session) return 'Error: No browser session. Call "open" first.';
            await mgr.scroll(session.id, deltaY ?? 300);
            return `Scrolled by ${deltaY ?? 300}px`;
          }
          case 'new_tab': {
            const session = mgr.getSessionBySubagent(chatKey);
            if (!session) return 'Error: No browser session. Call "open" first.';
            const result = await mgr.newTab(session.id, url);
            return `Opened new tab #${result.tabIndex}${url ? ` at ${url} (title: ${result.title})` : ''}. It is now the active tab.`;
          }
          case 'switch_tab': {
            if (tabIndex == null) return 'Error: "tabIndex" required for "switch_tab".';
            const session = mgr.getSessionBySubagent(chatKey);
            if (!session) return 'Error: No browser session. Call "open" first.';
            mgr.switchTab(session.id, tabIndex);
            return `Switched to tab #${tabIndex}.`;
          }
          case 'close_tab': {
            if (tabIndex == null) return 'Error: "tabIndex" required for "close_tab".';
            const session = mgr.getSessionBySubagent(chatKey);
            if (!session) return 'Error: No browser session. Call "open" first.';
            await mgr.closeTab(session.id, tabIndex);
            return `Closed tab #${tabIndex}.`;
          }
          case 'list_tabs': {
            const session = mgr.getSessionBySubagent(chatKey);
            if (!session) return 'Error: No browser session. Call "open" first.';
            const tabs = mgr.listTabs(session.id);
            return `Open tabs: ${tabs.map(t => `#${t.tabIndex}${t.active ? ' (active)' : ''}`).join(', ')}`;
          }
          case 'close': {
            const session = mgr.getSessionBySubagent(chatKey);
            if (!session) return 'Browser session already closed.';
            await mgr.destroySession(session.id);
            return 'Browser closed.';
          }
          default:
            return `Error: Unknown action "${action}".`;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        api.logger.error(`[browser-tool] ${action} failed: ${msg}`);
        return `Error: ${msg}`;
      }
    },
  }));

  api.logger.info('[browser-tool] Registered browser tool (Browserbase backend)');
}
