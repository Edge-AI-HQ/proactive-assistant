/**
 * Browser session types — Browserbase backend.
 */
import type { Browser, Page } from 'playwright-core';

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
  controlMode: 'ai' | 'user' | 'idle';
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
  /** All open pages keyed by tab index (0-based). */
  pages: Map<number, Page>;
  /** Index of the currently active tab. */
  activeTab: number;
}

export interface CreateSessionOpts {
  subagentId: string;
  url?: string;
  viewport?: { width: number; height: number };
}
