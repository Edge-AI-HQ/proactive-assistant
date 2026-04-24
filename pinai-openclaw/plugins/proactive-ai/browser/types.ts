/**
 * Browser session types — Browserbase backend.
 */
import type { Browser, Page } from 'playwright-core';
import type { BrowserControlMode } from './control-state.js';

export type BrowserSessionStatus = 'creating' | 'connecting' | 'live' | 'closing' | 'closed';

export interface BrowserSession {
  /** Internal session ID */
  id: string;
  /** Chat session key (maps 1:1 to a subagent / SSE stream) */
  subagentId: string;
  /** Browserbase session ID */
  browserbaseSessionId: string;
  /** Browserbase CDP WebSocket URL */
  connectUrl: string;
  /** Browserbase Live View URL (for frontend iframe) */
  liveViewUrl: string;
  /** Viewport size */
  viewport: { width: number; height: number };
  /** Current control mode */
  controlMode: BrowserControlMode;
  /** AI-provided reason when control was handed to the user. */
  takeoverReason: string | null;
  /** Last time controlMode/takeoverReason changed. */
  controlUpdatedAt: number;
  /** Session lifecycle status */
  status: BrowserSessionStatus;
  /** Timestamp when session was created */
  createdAt: number;
  /** Timestamp of last CDP activity (for idle detection) */
  lastActivityAt: number;
}

/** Internal session with Playwright refs (not exposed to clients). */
export interface InternalSession extends BrowserSession {
  browser: Browser | null;
  /** All open tabs in creation order. Tabs opened via target=_blank or
   *  window.open are auto-appended through a context `page` listener. */
  pages: Page[];
  /** Index into `pages` of the active tab. Every action method (click, type,
   *  snapshot, etc.) operates on this tab. */
  activePageIdx: number;
  /** True once a snapshot has been taken — used to give the agent a useful
   *  error instead of a raw "locator not found" when it guesses a ref
   *  without calling snapshot first. Reset to false on tab switch or
   *  fresh tab open since refs are page-local. */
  hasSnapshotted: boolean;
  /** Recent console messages (JS errors / warnings / logs) captured from
   *  all tabs, oldest first, capped to prevent unbounded growth. */
  consoleBuffer: ConsoleEntry[];
}

export interface ConsoleEntry {
  /** Timestamp ms. */
  at: number;
  /** Playwright console msg type: log / info / warn / error / debug / ... */
  level: string;
  text: string;
  /** Which tab emitted it (index into session.pages at the time). */
  tabIndex: number;
}

export interface TabInfo {
  index: number;
  url: string;
  title: string;
  active: boolean;
}

export interface CreateSessionOpts {
  subagentId: string;
  url?: string;
  viewport?: { width: number; height: number };
}

/** Named viewport presets the tool exposes. */
export const VIEWPORT_PRESETS = {
  mobile: { width: 390, height: 844 },
  desktop: { width: 1280, height: 800 },
} as const;
export type ViewportPreset = keyof typeof VIEWPORT_PRESETS;
