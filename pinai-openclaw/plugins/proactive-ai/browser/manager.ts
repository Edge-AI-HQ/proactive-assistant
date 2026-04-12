/**
 * Browserbase Session Manager
 *
 * Single owner of browser session lifecycle. All state transitions
 * and events are managed here — callers (tool.ts, routes) only
 * invoke public methods, never emit events directly.
 *
 * Lifecycle:
 *   createSession()  → emit browser:opened
 *   destroySession() → emit browser:closed  (single exit point)
 *
 * Destruction triggers:
 *   - AI calls browser:close → destroySession()
 *   - Idle timeout           → destroySession()
 *   - CDP reconnect failure  → destroySession()
 *   - Health check detects remote session gone → destroySession()
 *   - Process shutdown       → destroyAll() → destroySession() per session
 */
import Browserbase from '@browserbasehq/sdk';
import { chromium } from 'playwright-core';
import { randomUUID } from 'node:crypto';
import type { BrowserSession, InternalSession, CreateSessionOpts } from './types.js';
import { browserEvents } from './events.js';

const MAX_SESSIONS = 5;
const IDLE_TIMEOUT_MS = parseInt(process.env.BROWSERBASE_IDLE_TIMEOUT_MS ?? '300000', 10);
const HEALTH_CHECK_INTERVAL_MS = 60_000;
const CDP_RECONNECT_MAX = 3;
const CDP_RECONNECT_BASE_MS = 2000;
const CDP_CONNECT_TIMEOUT_MS = 15_000;
const BB_SESSION_TIMEOUT = parseInt(process.env.BROWSERBASE_SESSION_TIMEOUT ?? '900', 10);

/** Browserbase session statuses that mean the remote browser is gone. */
const DEAD_STATUSES = new Set(['COMPLETED', 'TIMED_OUT', 'ERROR']);

interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export class BrowserbaseManager {
  private sessions = new Map<string, InternalSession>();
  private bb: Browserbase;
  private logger: Logger;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private shuttingDown = false;
  private reconnecting = new Set<string>();

  constructor(logger?: Logger) {
    this.logger = logger ?? { info: console.log, warn: console.warn, error: console.error };
    const apiKey = process.env.BROWSERBASE_API_KEY;
    if (!apiKey) {
      throw new Error('BROWSERBASE_API_KEY environment variable is required');
    }
    this.bb = new Browserbase({ apiKey });
    this.startHealthCheck();

    const cleanup = () => { void this.destroyAll(); };
    process.on('SIGTERM', cleanup);
    process.on('SIGINT', cleanup);
  }

  // ── Public API ────────────────────────────────────────────────────────

  async createSession(opts: CreateSessionOpts): Promise<BrowserSession> {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error(`Max sessions (${MAX_SESSIONS}) reached`);
    }

    const id = randomUUID();
    const viewport = opts.viewport ?? { width: 390, height: 844 };
    const now = Date.now();

    const session: InternalSession = {
      id,
      subagentId: opts.subagentId,
      browserbaseSessionId: '',
      connectUrl: '',
      liveViewUrl: '',
      viewport,
      controlMode: 'ai',
      status: 'creating',
      createdAt: now,
      lastActivityAt: now,
      browser: null,
      pages: new Map(),
      activeTab: 0,
    };
    this.sessions.set(id, session);

    try {
      this.logger.info(`[browserbase] Creating session ${id}...`);

      const bbSession = await this.bb.sessions.create({
        projectId: process.env.BROWSERBASE_PROJECT_ID!,
        browserSettings: {
          viewport: { width: viewport.width, height: viewport.height },
          solveCaptchas: true,
        },
        keepAlive: true,
        timeout: BB_SESSION_TIMEOUT,
      });

      session.browserbaseSessionId = bbSession.id;
      session.connectUrl = bbSession.connectUrl;

      const debugInfo = await this.bb.sessions.debug(bbSession.id);
      session.liveViewUrl = debugInfo.debuggerFullscreenUrl;

      session.status = 'connecting';
      this.logger.info(`[browserbase] Connecting CDP to ${bbSession.id}...`);

      const browser = await chromium.connectOverCDP(bbSession.connectUrl);
      session.browser = browser;

      const contexts = browser.contexts();
      const existingPages = contexts[0]?.pages() ?? [];
      const firstPage = existingPages[0] ?? await contexts[0]?.newPage() ?? await browser.newPage();
      session.pages.set(0, firstPage);
      session.activeTab = 0;

      if (opts.url) {
        await firstPage.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      }

      this.attachDisconnectHandler(session, browser);

      session.status = 'live';
      this.logger.info(`[browserbase] Session ${id} is live (bb=${bbSession.id})`);

      // Emit opened — manager is the sole event source
      browserEvents.emit({
        type: 'browser:opened',
        sessionKey: session.subagentId,
        browserSessionId: id,
        liveViewUrl: session.liveViewUrl,
        viewport: session.viewport,
        url: opts.url ?? '',
      });

      return this.toPublicSession(session);
    } catch (err) {
      session.status = 'closed';
      this.sessions.delete(id);
      await this.releaseBBSession(session).catch(() => {});
      throw err;
    }
  }

  /**
   * Single exit point for session destruction.
   * All paths that end a session MUST call this.
   */
  async destroySession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.status === 'closing' || session.status === 'closed') return;

    session.status = 'closing';
    this.logger.info(`[browserbase] Destroying session ${sessionId}`);

    if (session.browser) {
      try { await session.browser.close(); } catch {}
      session.browser = null;
      session.pages.clear();
    }

    await this.releaseBBSession(session);
    session.status = 'closed';
    this.sessions.delete(sessionId);

    browserEvents.emit({
      type: 'browser:closed',
      sessionKey: session.subagentId,
      browserSessionId: sessionId,
    });
  }

  async navigate(sessionId: string, url: string): Promise<{ title: string }> {
    const page = this.requirePage(sessionId);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    this.touch(sessionId);

    browserEvents.emit({
      type: 'browser:navigated',
      sessionKey: this.sessions.get(sessionId)!.subagentId,
      browserSessionId: sessionId,
      url,
    });

    return { title: await page.title() };
  }

  async click(sessionId: string, x: number, y: number): Promise<void> {
    const page = this.requirePage(sessionId);
    await page.mouse.click(x, y);
    this.touch(sessionId);
  }

  async type(sessionId: string, text: string): Promise<void> {
    const page = this.requirePage(sessionId);
    await page.keyboard.type(text);
    this.touch(sessionId);
  }

  async scroll(sessionId: string, deltaY: number): Promise<void> {
    const page = this.requirePage(sessionId);
    await page.mouse.wheel(0, deltaY);
    this.touch(sessionId);
  }

  async screenshot(sessionId: string): Promise<Buffer> {
    const page = this.requirePage(sessionId);
    this.touch(sessionId);
    return page.screenshot({ type: 'jpeg', quality: 75 });
  }

  async newTab(sessionId: string, url?: string): Promise<{ tabIndex: number; title: string }> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.browser || session.status !== 'live') {
      throw new Error(`No active browser for session ${sessionId}`);
    }
    const context = session.browser.contexts()[0];
    if (!context) throw new Error('No browser context');
    const page = await context.newPage();
    const tabIndex = session.pages.size;
    session.pages.set(tabIndex, page);
    session.activeTab = tabIndex;
    if (url) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    }
    this.touch(sessionId);
    return { tabIndex, title: await page.title() };
  }

  switchTab(sessionId: string, tabIndex: number): { tabIndex: number } {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'live') {
      throw new Error(`No active browser for session ${sessionId}`);
    }
    if (!session.pages.has(tabIndex)) {
      throw new Error(`Tab ${tabIndex} does not exist. Open tabs: ${[...session.pages.keys()].join(', ')}`);
    }
    session.activeTab = tabIndex;
    this.touch(sessionId);
    return { tabIndex };
  }

  async closeTab(sessionId: string, tabIndex: number): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'live') {
      throw new Error(`No active browser for session ${sessionId}`);
    }
    const page = session.pages.get(tabIndex);
    if (!page) throw new Error(`Tab ${tabIndex} does not exist`);
    if (session.pages.size <= 1) throw new Error('Cannot close the last tab. Use "close" to end the browser session.');
    await page.close();
    session.pages.delete(tabIndex);
    if (session.activeTab === tabIndex) {
      session.activeTab = session.pages.keys().next().value!;
    }
    this.touch(sessionId);
  }

  listTabs(sessionId: string): Array<{ tabIndex: number; active: boolean }> {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'live') return [];
    return [...session.pages.keys()].map(i => ({ tabIndex: i, active: i === session.activeTab }));
  }

  getSession(sessionId: string): BrowserSession | undefined {
    const s = this.sessions.get(sessionId);
    return s ? this.toPublicSession(s) : undefined;
  }

  getSessionBySubagent(subagentId: string): BrowserSession | undefined {
    for (const s of this.sessions.values()) {
      if (s.subagentId === subagentId && s.status !== 'closed') {
        return this.toPublicSession(s);
      }
    }
    return undefined;
  }

  listSessions(): BrowserSession[] {
    return [...this.sessions.values()].map(s => this.toPublicSession(s));
  }

  setControlMode(sessionId: string, mode: 'ai' | 'user' | 'idle'): void {
    const session = this.sessions.get(sessionId);
    if (session) session.controlMode = mode;
  }

  async destroyAll(): Promise<void> {
    this.shuttingDown = true;
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    const ids = [...this.sessions.keys()];
    await Promise.allSettled(ids.map(id => this.destroySession(id)));
  }

  // ── Private ──────────────────────────────────────────────────────────

  private requirePage(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'live') {
      throw new Error(`No active browser session for ${sessionId}`);
    }
    const page = session.pages.get(session.activeTab);
    if (!page) {
      throw new Error(`No active tab (${session.activeTab}) for session ${sessionId}`);
    }
    return page;
  }

  private touch(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) session.lastActivityAt = Date.now();
  }

  private toPublicSession(s: InternalSession): BrowserSession {
    return {
      id: s.id,
      subagentId: s.subagentId,
      browserbaseSessionId: s.browserbaseSessionId,
      connectUrl: s.connectUrl,
      liveViewUrl: s.liveViewUrl,
      viewport: s.viewport,
      controlMode: s.controlMode,
      status: s.status,
      createdAt: s.createdAt,
      lastActivityAt: s.lastActivityAt,
    };
  }

  private async releaseBBSession(session: InternalSession): Promise<void> {
    if (!session.browserbaseSessionId) return;
    try {
      await this.bb.sessions.update(session.browserbaseSessionId, { status: 'REQUEST_RELEASE' });
      this.logger.info(`[browserbase] Released BB session ${session.browserbaseSessionId}`);
    } catch (err) {
      this.logger.warn(`[browserbase] Failed to release BB session: ${err instanceof Error ? err.message : err}`);
    }
  }

  private attachDisconnectHandler(session: InternalSession, browser: NonNullable<InternalSession['browser']>): void {
    browser.on('disconnected', () => {
      if (session.status === 'live' && !this.shuttingDown) {
        this.logger.warn(`[browserbase] CDP disconnected for session ${session.id}, attempting reconnect...`);
        void this.reconnectCDP(session);
      }
    });
  }

  private async reconnectCDP(session: InternalSession): Promise<void> {
    if (this.reconnecting.has(session.id)) {
      this.logger.info(`[browserbase] Reconnect already in progress for ${session.id}, skipping`);
      return;
    }
    this.reconnecting.add(session.id);

    try {
      for (let attempt = 1; attempt <= CDP_RECONNECT_MAX; attempt++) {
        const delay = CDP_RECONNECT_BASE_MS * Math.pow(2, attempt - 1);
        this.logger.info(`[browserbase] Reconnect attempt ${attempt}/${CDP_RECONNECT_MAX} in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));

        if (session.status !== 'live' && session.status !== 'connecting') return;

        try {
          const bbSession = await this.bb.sessions.retrieve(session.browserbaseSessionId);

          // Remote session already dead — no point reconnecting
          if (DEAD_STATUSES.has(bbSession.status)) {
            this.logger.warn(`[browserbase] Remote session ${session.browserbaseSessionId} is ${bbSession.status}, destroying`);
            await this.destroySession(session.id);
            return;
          }

          if (bbSession.connectUrl) session.connectUrl = bbSession.connectUrl;

          const browser = await Promise.race([
            chromium.connectOverCDP(session.connectUrl),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('CDP connect timeout')), CDP_CONNECT_TIMEOUT_MS)
            ),
          ]);
          session.browser = browser;

          const contexts = browser.contexts();
          const existingPages = contexts[0]?.pages() ?? [];
          session.pages.clear();
          existingPages.forEach((p, i) => session.pages.set(i, p));
          session.activeTab = Math.min(session.activeTab, Math.max(0, existingPages.length - 1));

          this.attachDisconnectHandler(session, browser);

          session.status = 'live';
          this.logger.info(`[browserbase] Reconnected CDP for session ${session.id}`);
          return;
        } catch (err) {
          this.logger.warn(`[browserbase] Reconnect attempt ${attempt} failed: ${err instanceof Error ? err.message : err}`);
        }
      }

      // All attempts exhausted — destroy through the single exit point
      this.logger.error(`[browserbase] CDP reconnect failed after ${CDP_RECONNECT_MAX} attempts for session ${session.id}`);
      await this.destroySession(session.id);
    } finally {
      this.reconnecting.delete(session.id);
    }
  }

  /**
   * Unified health check loop — handles both idle detection and
   * Browserbase remote session liveness in a single pass.
   */
  private startHealthCheck(): void {
    this.healthTimer = setInterval(async () => {
      const now = Date.now();
      for (const [id, session] of this.sessions) {
        if (session.status !== 'live') continue;

        // 1. Idle timeout
        if ((now - session.lastActivityAt) > IDLE_TIMEOUT_MS) {
          this.logger.info(`[browserbase] Session ${id} idle for ${Math.round((now - session.lastActivityAt) / 1000)}s, destroying`);
          void this.destroySession(id);
          continue;
        }

        // 2. Remote liveness — check if Browserbase session still exists
        if (session.browserbaseSessionId) {
          try {
            const bbSession = await this.bb.sessions.retrieve(session.browserbaseSessionId);
            if (DEAD_STATUSES.has(bbSession.status)) {
              this.logger.warn(`[browserbase] Remote session ${session.browserbaseSessionId} is ${bbSession.status}, destroying local session ${id}`);
              void this.destroySession(id);
            }
          } catch {
            // API call failed — don't destroy, retry next cycle
          }
        }
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }
}
