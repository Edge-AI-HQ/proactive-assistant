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
import { chromium, type Locator, type Page } from 'playwright-core';
import { randomUUID } from 'node:crypto';
import type { BrowserSession, InternalSession, CreateSessionOpts, ConsoleEntry, TabInfo } from './types.js';
import { VIEWPORT_PRESETS, type ViewportPreset } from './types.js';
import { browserEvents } from './events.js';
import { assertBrowserToolAllowed, type BrowserControlMode } from './control-state.js';

const CONSOLE_BUFFER_MAX = 200;

/** Snapshot depth cap — Playwright's ai-mode tree can be huge on SPAs. */
const SNAPSHOT_MAX_DEPTH = 25;

const POST_ACTION_SETTLE_MS = 400;

const MAX_SESSIONS = 5;
const IDLE_TIMEOUT_MS = parseInt(process.env.BROWSERBASE_IDLE_TIMEOUT_MS ?? '300000', 10);
const HEALTH_CHECK_INTERVAL_MS = 60_000;
const CDP_RECONNECT_MAX = 3;
const CDP_RECONNECT_BASE_MS = 2000;
const CDP_CONNECT_TIMEOUT_MS = 15_000;
const BB_SESSION_TIMEOUT = parseInt(process.env.BROWSERBASE_SESSION_TIMEOUT ?? '900', 10);

/** Browserbase session statuses that mean the remote browser is gone. */
const DEAD_STATUSES = new Set(['COMPLETED', 'TIMED_OUT', 'ERROR']);

/**
 * How long after a destroySession we must wait before reusing the same
 * persistent context. Browserbase docs: "wait a few seconds before
 * reusing the Context to ensure data is synchronized." Tuned a little
 * above the "few seconds" to be safe without being noticeable.
 */
const CONTEXT_SYNC_WAIT_MS = 3000;

/**
 * Detect errors from `bb.sessions.create({ context: { id } })` that
 * indicate the referenced context no longer exists on Browserbase.
 * We widen matching because the SDK's error shape isn't documented —
 * match on HTTP 404 and on common wording so future minor changes
 * don't leave us failing silently.
 */
function isStaleContextError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { status?: number; statusCode?: number; message?: string };
  const status = e.status ?? e.statusCode;
  if (status === 404) return true;
  const msg = String(e.message ?? err).toLowerCase();
  if (status === 400 && msg.includes('context')) return true;
  return (
    msg.includes('context') &&
    (msg.includes('not found') ||
      msg.includes('invalid') ||
      msg.includes('does not exist'))
  );
}

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

  /**
   * Promise chain that serializes createSession calls across the
   * manager. Browserbase explicitly recommends against simultaneous
   * sessions on the same persistent context (cookie writes on close
   * can race). Since every session in this container shares the same
   * BROWSERBASE_CONTEXT_ID, a single chain is enough.
   */
  private createChain: Promise<unknown> = Promise.resolve();

  /**
   * Time of the most recent destroySession completion. createSession
   * waits CONTEXT_SYNC_WAIT_MS past this mark before asking Browserbase
   * to boot a new session on the same context.
   */
  private lastContextDestroyAt = 0;

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
    // Serialize concurrent create calls. Each caller queues onto the
    // previous promise; the .catch() ensures one caller's failure
    // doesn't poison subsequent ones.
    const prev = this.createChain;
    let release!: () => void;
    this.createChain = new Promise<void>((r) => {
      release = r;
    });
    await prev.catch(() => {});
    try {
      return await this.createSessionLocked(opts);
    } finally {
      release();
    }
  }

  private async createSessionLocked(opts: CreateSessionOpts): Promise<BrowserSession> {
    // Defense in depth: if a prior session for this subagent is still on
    // record (e.g. the Browserbase session died silently and health check
    // hasn't caught it yet), destroy it first. Otherwise the events bus
    // carries a stale browser:opened with a dead liveViewUrl and the
    // frontend iframe points at a 404.
    const prior = this.getSessionBySubagent(opts.subagentId);
    if (prior) {
      await this.destroySession(prior.id).catch(() => {});
    }

    // After a destroy on this context, wait a beat for Browserbase to
    // sync cookies/localStorage back to the persistent context. Skipping
    // this risks booting the next session with pre-destroy state.
    if (this.lastContextDestroyAt > 0) {
      const elapsed = Date.now() - this.lastContextDestroyAt;
      if (elapsed < CONTEXT_SYNC_WAIT_MS) {
        const wait = CONTEXT_SYNC_WAIT_MS - elapsed;
        this.logger.info(
          `[browserbase] Waiting ${wait}ms for persisted context to sync before new session`,
        );
        await new Promise((r) => setTimeout(r, wait));
      }
    }

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
      takeoverReason: null,
      controlUpdatedAt: now,
      status: 'creating',
      createdAt: now,
      lastActivityAt: now,
      browser: null,
      pages: [],
      activePageIdx: 0,
      hasSnapshotted: false,
      consoleBuffer: [],
    };
    this.sessions.set(id, session);

    try {
      this.logger.info(`[browserbase] Creating session ${id}...`);

      // If the orchestrator provisioned a persistent context for this user
      // (BROWSERBASE_CONTEXT_ID injected at container spawn), attach it so
      // the session restores cookies/localStorage from prior runs and
      // writes them back on close. Falls back to an anonymous session
      // when the env var is unset — used by tests and by spawns that
      // happened before this feature shipped.
      const contextId = process.env.BROWSERBASE_CONTEXT_ID;
      const browserSettings: Parameters<typeof this.bb.sessions.create>[0]['browserSettings'] = {
        viewport: { width: viewport.width, height: viewport.height },
        solveCaptchas: true,
      };
      if (contextId) {
        browserSettings.context = { id: contextId, persist: true };
        this.logger.info(`[browserbase] Using persistent context ${contextId}`);
      }

      const bbCreateOpts = {
        projectId: process.env.BROWSERBASE_PROJECT_ID!,
        browserSettings,
        keepAlive: true,
        timeout: BB_SESSION_TIMEOUT,
      };

      // Stale-context recovery: if the orchestrator-injected context has
      // been deleted on Browserbase's side (manual cleanup, project
      // rotation, etc.), `sessions.create` fails. Rather than crashing
      // the tool call we retry anonymously so the agent can still do
      // this turn's work. The DB still points at the dead context, but
      // the orchestrator will create a fresh one on the next container
      // spawn; user-visible impact is just losing saved logins for a
      // single conversation.
      let bbSession;
      try {
        bbSession = await this.bb.sessions.create(bbCreateOpts);
      } catch (err) {
        if (contextId && isStaleContextError(err)) {
          this.logger.warn(
            `[browserbase] Context ${contextId} appears stale (${
              err instanceof Error ? err.message : String(err)
            }); falling back to anonymous session`,
          );
          const fallbackSettings: typeof browserSettings = { ...browserSettings };
          delete fallbackSettings.context;
          bbSession = await this.bb.sessions.create({
            ...bbCreateOpts,
            browserSettings: fallbackSettings,
          });
        } else {
          throw err;
        }
      }

      session.browserbaseSessionId = bbSession.id;
      session.connectUrl = bbSession.connectUrl;

      const debugInfo = await this.bb.sessions.debug(bbSession.id);
      session.liveViewUrl = debugInfo.debuggerFullscreenUrl;

      session.status = 'connecting';
      this.logger.info(`[browserbase] Connecting CDP to ${bbSession.id}...`);

      const browser = await chromium.connectOverCDP(bbSession.connectUrl);
      session.browser = browser;

      const contexts = browser.contexts();
      const context = contexts[0];
      const existingPages = context?.pages() ?? [];
      const firstPage = existingPages[0] ?? (await context?.newPage()) ?? (await browser.newPage());
      session.pages = [firstPage];
      session.activePageIdx = 0;
      this.attachPageInstrumentation(session, firstPage);

      // Auto-track new tabs opened by the page (target=_blank, window.open, OAuth).
      if (context) {
        context.on('page', (p) => {
          const s = this.sessions.get(id);
          if (!s || s.pages.includes(p)) return;
          s.pages.push(p);
          this.attachPageInstrumentation(s, p);
          this.logger.info(`[browserbase] Session ${id} new tab at ${p.url()} (now ${s.pages.length} tabs)`);
        });
      }

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
        controlMode: session.controlMode,
        takeoverReason: session.takeoverReason,
        controlUpdatedAt: session.controlUpdatedAt,
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
      session.pages = [];
    }

    await this.releaseBBSession(session);
    session.status = 'closed';
    this.sessions.delete(sessionId);

    // Mark so the next createSession on this context waits for
    // Browserbase to sync persisted state before reusing it.
    this.lastContextDestroyAt = Date.now();

    browserEvents.emit({
      type: 'browser:closed',
      sessionKey: session.subagentId,
      browserSessionId: sessionId,
    });
  }

  async navigate(sessionId: string, url: string): Promise<{ title: string; snapshot: string }> {
    this.assertAiCanUse(sessionId, 'navigate');
    const page = this.requirePage(sessionId);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    this.touch(sessionId);

    browserEvents.emit({
      type: 'browser:navigated',
      sessionKey: this.sessions.get(sessionId)!.subagentId,
      browserSessionId: sessionId,
      url,
    });

    const title = await page.title();
    const snapshot = await this.snapshot(sessionId);
    return { title, snapshot };
  }

  /**
   * Capture an AI-optimized aria snapshot of the current page. The returned
   * YAML contains [ref=eN] annotations; pass those refs back to clickRef /
   * typeRef / selectOption / waitFor to target a specific element.
   *
   * Playwright owns the ref lifetime — calling snapshot again invalidates
   * prior refs. We just record that a snapshot happened so we can return a
   * useful error when the agent tries to act without one.
   */
  async snapshot(sessionId: string): Promise<string> {
    const page = this.requirePage(sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`No session ${sessionId}`);

    const url = page.url();
    const title = await page.title().catch(() => '');

    let body: string;
    try {
      body = await page.locator('body').ariaSnapshot({
        mode: 'ai',
        depth: SNAPSHOT_MAX_DEPTH,
      });
      session.hasSnapshotted = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[browserbase] ariaSnapshot failed: ${msg}`);
      body = `(snapshot failed: ${msg} — the page may still be loading; try again or call wait first)`;
    }

    this.touch(sessionId);
    return `URL: ${url}${title ? `\nTitle: ${title}` : ''}\n\n${body}`;
  }

  async clickRef(sessionId: string, ref: string): Promise<string> {
    this.assertAiCanUse(sessionId, 'click');
    const page = this.requirePage(sessionId);
    const locator = this.resolveLocator(page, sessionId, ref);
    await locator.click({ timeout: 15_000 });
    await this.settle(page);
    this.touch(sessionId);
    return this.snapshot(sessionId);
  }

  /**
   * Type text into the element identified by ref.
   * clear=true (default): fills the field (replacing existing value).
   * clear=false: types key-by-key at the current selection.
   */
  async typeRef(
    sessionId: string,
    ref: string,
    text: string,
    opts?: { clear?: boolean },
  ): Promise<string> {
    this.assertAiCanUse(sessionId, 'type');
    const page = this.requirePage(sessionId);
    const locator = this.resolveLocator(page, sessionId, ref);
    if (opts?.clear === false) {
      await locator.focus({ timeout: 10_000 });
      await page.keyboard.type(text);
    } else {
      await locator.fill(text, { timeout: 15_000 });
    }
    await this.settle(page);
    this.touch(sessionId);
    return this.snapshot(sessionId);
  }

  /** Press a keyboard key (Enter / Tab / Escape / ArrowDown / etc.). */
  async pressKey(sessionId: string, key: string): Promise<string> {
    this.assertAiCanUse(sessionId, 'press_key');
    const page = this.requirePage(sessionId);
    await page.keyboard.press(key);
    await this.settle(page);
    this.touch(sessionId);
    return this.snapshot(sessionId);
  }

  async selectOption(
    sessionId: string,
    ref: string,
    value: string | string[],
  ): Promise<string> {
    this.assertAiCanUse(sessionId, 'select');
    const page = this.requirePage(sessionId);
    const locator = this.resolveLocator(page, sessionId, ref);
    await locator.selectOption(value, { timeout: 15_000 });
    await this.settle(page);
    this.touch(sessionId);
    return this.snapshot(sessionId);
  }

  async waitFor(
    sessionId: string,
    opts: {
      ref?: string;
      state?: 'visible' | 'hidden' | 'attached' | 'detached';
      urlContains?: string;
      timeoutMs?: number;
    },
  ): Promise<string> {
    this.assertAiCanUse(sessionId, 'wait');
    const page = this.requirePage(sessionId);
    const timeout = opts.timeoutMs ?? 10_000;

    if (opts.urlContains) {
      const needle = opts.urlContains;
      await page.waitForURL((u) => u.toString().includes(needle), { timeout });
    } else if (opts.ref) {
      const locator = this.resolveLocator(page, sessionId, opts.ref);
      await locator.waitFor({ state: opts.state ?? 'visible', timeout });
    } else {
      await page.waitForLoadState('networkidle', { timeout }).catch(() => {});
    }

    this.touch(sessionId);
    return this.snapshot(sessionId);
  }

  async scroll(sessionId: string, deltaY: number): Promise<string> {
    this.assertAiCanUse(sessionId, 'scroll');
    const page = this.requirePage(sessionId);
    await page.mouse.wheel(0, deltaY);
    await this.settle(page);
    this.touch(sessionId);
    return this.snapshot(sessionId);
  }

  async setViewport(
    sessionId: string,
    viewport: ViewportPreset | { width: number; height: number },
  ): Promise<string> {
    this.assertAiCanUse(sessionId, 'set_viewport');
    const page = this.requirePage(sessionId);
    const size = typeof viewport === 'string' ? VIEWPORT_PRESETS[viewport] : viewport;
    await page.setViewportSize(size);
    const session = this.sessions.get(sessionId);
    if (session) session.viewport = { width: size.width, height: size.height };
    await this.settle(page);
    this.touch(sessionId);
    return this.snapshot(sessionId);
  }

  async screenshot(sessionId: string): Promise<Buffer> {
    const page = this.requirePage(sessionId);
    this.touch(sessionId);
    return page.screenshot({ type: 'jpeg', quality: 75 });
  }

  /** Read trimmed text content of an element. Useful for reading OTP codes,
   *  confirmation numbers, or any on-page info the agent needs as a value. */
  async getText(sessionId: string, ref: string): Promise<string> {
    this.assertAiCanUse(sessionId, 'get_text');
    const page = this.requirePage(sessionId);
    const locator = this.resolveLocator(page, sessionId, ref);
    const raw = await locator.textContent({ timeout: 5_000 });
    this.touch(sessionId);
    return (raw ?? '').trim();
  }

  async scrollToRef(sessionId: string, ref: string): Promise<string> {
    this.assertAiCanUse(sessionId, 'scroll_to');
    const page = this.requirePage(sessionId);
    const locator = this.resolveLocator(page, sessionId, ref);
    await locator.scrollIntoViewIfNeeded({ timeout: 10_000 });
    await this.settle(page);
    this.touch(sessionId);
    return this.snapshot(sessionId);
  }

  async goBack(sessionId: string): Promise<string> {
    this.assertAiCanUse(sessionId, 'go_back');
    const page = this.requirePage(sessionId);
    await page.goBack({ timeout: 15_000, waitUntil: 'domcontentloaded' });
    await this.settle(page);
    this.touch(sessionId);
    return this.snapshot(sessionId);
  }

  async goForward(sessionId: string): Promise<string> {
    this.assertAiCanUse(sessionId, 'go_forward');
    const page = this.requirePage(sessionId);
    await page.goForward({ timeout: 15_000, waitUntil: 'domcontentloaded' });
    await this.settle(page);
    this.touch(sessionId);
    return this.snapshot(sessionId);
  }

  async reload(sessionId: string): Promise<string> {
    this.assertAiCanUse(sessionId, 'reload');
    const page = this.requirePage(sessionId);
    await page.reload({ timeout: 30_000, waitUntil: 'domcontentloaded' });
    await this.settle(page);
    this.touch(sessionId);
    return this.snapshot(sessionId);
  }

  /** Attach a file at `filePath` (relative to the container's /app) to a
   *  file-input element identified by ref. Used for "upload document"
   *  style flows. */
  async uploadFile(sessionId: string, ref: string, filePath: string): Promise<string> {
    this.assertAiCanUse(sessionId, 'upload_file');
    const page = this.requirePage(sessionId);
    const locator = this.resolveLocator(page, sessionId, ref);
    await locator.setInputFiles(filePath, { timeout: 15_000 });
    await this.settle(page);
    this.touch(sessionId);
    return this.snapshot(sessionId);
  }

  // ── Tier 3: tabs ──────────────────────────────────────────────────

  async newTab(sessionId: string, url?: string): Promise<string> {
    this.assertAiCanUse(sessionId, 'new_tab');
    const session = this.sessions.get(sessionId);
    if (!session || !session.browser) throw new Error(`No active session ${sessionId}`);
    const context = session.browser.contexts()[0];
    if (!context) throw new Error('No browser context available');
    const page = await context.newPage();
    // newPage fires context 'page' event which auto-appends; ensure we
    // include it even if the listener missed it (defensive).
    if (!session.pages.includes(page)) session.pages.push(page);
    session.activePageIdx = session.pages.indexOf(page);
    this.attachPageInstrumentation(session, page);
    session.hasSnapshotted = false;
    if (url) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    }
    this.touch(sessionId);
    return this.snapshot(sessionId);
  }

  async switchTab(sessionId: string, index: number): Promise<string> {
    this.assertAiCanUse(sessionId, 'switch_tab');
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`No session ${sessionId}`);
    if (index < 0 || index >= session.pages.length) {
      throw new Error(`Invalid tab index ${index}. Open tabs: ${session.pages.length}`);
    }
    session.activePageIdx = index;
    session.hasSnapshotted = false;
    this.touch(sessionId);
    return this.snapshot(sessionId);
  }

  async closeTab(sessionId: string, index: number): Promise<string> {
    this.assertAiCanUse(sessionId, 'close_tab');
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`No session ${sessionId}`);
    if (session.pages.length <= 1) {
      throw new Error('Cannot close the last tab. Use "close" to end the browser session.');
    }
    if (index < 0 || index >= session.pages.length) {
      throw new Error(`Invalid tab index ${index}`);
    }
    const page = session.pages[index];
    if (page) {
      try { await page.close(); } catch {}
    }
    session.pages.splice(index, 1);
    if (session.activePageIdx === index) {
      session.activePageIdx = Math.min(index, session.pages.length - 1);
    } else if (session.activePageIdx > index) {
      session.activePageIdx -= 1;
    }
    session.hasSnapshotted = false;
    this.touch(sessionId);
    return this.snapshot(sessionId);
  }

  async listTabs(sessionId: string): Promise<TabInfo[]> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`No session ${sessionId}`);
    this.touch(sessionId);
    return Promise.all(
      session.pages.map(async (p, i) => ({
        index: i,
        url: p.url(),
        title: (await p.title().catch(() => '')) ?? '',
        active: i === session.activePageIdx,
      })),
    );
  }

  // ── Tier 3: dialog ────────────────────────────────────────────────

  /**
   * Arm a one-shot handler for the next native JS dialog (alert / confirm /
   * prompt / beforeunload). Call this BEFORE the action that triggers the
   * dialog — Playwright dialogs block page execution until responded to.
   */
  armDialog(sessionId: string, policy: 'accept' | 'dismiss', promptText?: string): void {
    this.assertAiCanUse(sessionId, 'handle_dialog');
    const page = this.requirePage(sessionId);
    const handler = async (dialog: { type: () => string; message: () => string; accept: (t?: string) => Promise<void>; dismiss: () => Promise<void> }) => {
      this.logger.info(`[browserbase] Dialog ${dialog.type()}: ${dialog.message()} → ${policy}`);
      try {
        if (policy === 'accept') await dialog.accept(promptText ?? '');
        else await dialog.dismiss();
      } catch (err) {
        this.logger.warn(`[browserbase] Dialog handler failed: ${err instanceof Error ? err.message : err}`);
      }
      page.off('dialog', handler);
    };
    page.on('dialog', handler);
    this.touch(sessionId);
  }

  // ── Tier 3: download ──────────────────────────────────────────────

  /**
   * Trigger a download by clicking an element and save it to `saveToPath`.
   * Combines waitForEvent('download') + click in one shot since Playwright
   * requires both to be co-scheduled.
   */
  async downloadFile(
    sessionId: string,
    triggerRef: string,
    saveToPath: string,
    timeoutMs = 60_000,
  ): Promise<{ path: string; suggestedFilename: string }> {
    this.assertAiCanUse(sessionId, 'download');
    const page = this.requirePage(sessionId);
    const locator = this.resolveLocator(page, sessionId, triggerRef);
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: timeoutMs }),
      locator.click({ timeout: 15_000 }),
    ]);
    await download.saveAs(saveToPath);
    this.touch(sessionId);
    return { path: saveToPath, suggestedFilename: download.suggestedFilename() };
  }

  // ── Tier 3: console ───────────────────────────────────────────────

  getConsoleLogs(sessionId: string, limit = 50): ConsoleEntry[] {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`No session ${sessionId}`);
    const buf = session.consoleBuffer;
    return buf.slice(Math.max(0, buf.length - limit));
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

  setControlMode(sessionId: string, mode: BrowserControlMode, reason?: string): BrowserSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    session.controlMode = mode;
    session.takeoverReason = mode === 'ai' ? null : reason ?? session.takeoverReason ?? null;
    session.controlUpdatedAt = Date.now();
    this.touch(sessionId);

    browserEvents.emit({
      type: 'browser:control',
      sessionKey: session.subagentId,
      browserSessionId: sessionId,
      mode,
      reason: session.takeoverReason ?? undefined,
    });
    return this.toPublicSession(session);
  }

  /**
   * Re-fetch a fresh `debuggerFullscreenUrl` from Browserbase for this
   * session. The returned URL carries a signed token with short TTL (a few
   * minutes); when it expires the iframe shows "Debugging connection was
   * closed — WebSocket". The frontend's Reload button calls this to
   * recover without destroying the underlying CDP session.
   */
  async refreshLiveViewUrl(sessionId: string): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`No session ${sessionId}`);
    if (!session.browserbaseSessionId) throw new Error(`Session ${sessionId} not yet connected`);

    const debugInfo = await this.bb.sessions.debug(session.browserbaseSessionId);
    const fresh = debugInfo.debuggerFullscreenUrl;
    session.liveViewUrl = fresh;
    this.touch(sessionId);
    return fresh;
  }

  /**
   * AI-initiated takeover. Flips mode to 'user' and emits a dedicated
   * takeover event so the frontend can surface the reason prominently.
   * Also emits browser:control so existing subscribers stay in sync.
   */
  requestUserTakeover(sessionId: string, reason: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`No session ${sessionId}`);
    session.controlMode = 'user';
    session.takeoverReason = reason;
    session.controlUpdatedAt = Date.now();
    this.touch(sessionId);

    browserEvents.emit({
      type: 'browser:takeover-requested',
      sessionKey: session.subagentId,
      browserSessionId: sessionId,
      reason,
    });
    browserEvents.emit({
      type: 'browser:control',
      sessionKey: session.subagentId,
      browserSessionId: sessionId,
      mode: 'user',
      reason,
    });
  }

  heartbeat(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`No session ${sessionId}`);
    this.touch(sessionId);
  }

  async typeUserInput(sessionId: string, text: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`No session ${sessionId}`);
    if (session.controlMode !== 'user') throw new Error('User input is only allowed while the user controls the browser.');
    const page = this.requirePage(sessionId);
    await page.keyboard.type(text);
    await this.settle(page);
    this.touch(sessionId);
  }

  async pressUserKey(sessionId: string, key: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`No session ${sessionId}`);
    if (session.controlMode !== 'user') throw new Error('User input is only allowed while the user controls the browser.');
    const page = this.requirePage(sessionId);
    await page.keyboard.press(key);
    await this.settle(page);
    this.touch(sessionId);
  }

  /**
   * Forward a user tap to a page coordinate during user takeover.
   * Coordinates are in remote page viewport units (the frontend scales
   * its overlay-local x/y against session.viewport before calling).
   * Browserbase Live View's DevTools UI doesn't reliably turn a native
   * tap on the iframe into a page click on mobile, so the frontend
   * captures the tap on a transparent overlay and POSTs it here.
   */
  async clickUserAt(sessionId: string, x: number, y: number): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`No session ${sessionId}`);
    if (session.controlMode !== 'user') throw new Error('User input is only allowed while the user controls the browser.');
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
      throw new Error('Invalid click coordinates');
    }
    const vp = session.viewport;
    if (x > vp.width * 1.1 || y > vp.height * 1.1) {
      // Guard against runaway coordinates (e.g. frontend forgot to scale).
      // Small over-spill is fine (scroll beyond fold).
      throw new Error(`Click coordinate (${x},${y}) out of viewport (${vp.width}x${vp.height})`);
    }
    const page = this.requirePage(sessionId);
    await page.mouse.click(x, y);
    await this.settle(page);
    this.touch(sessionId);
  }

  /**
   * Forward a user scroll gesture. dx/dy in CSS pixels; positive dy
   * scrolls content up (page content moves up as the user swipes up).
   * Clamped to reasonable per-call magnitudes because a single fast
   * swipe on mobile can produce thousand-pixel deltas that, when
   * multiplied by the imperfect viewport scaling, cause Playwright
   * to wheel past what the user actually saw.
   */
  async scrollUser(sessionId: string, dx: number, dy: number): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`No session ${sessionId}`);
    if (session.controlMode !== 'user') throw new Error('User input is only allowed while the user controls the browser.');
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
      throw new Error('Invalid scroll deltas');
    }
    const CLAMP = 2000;
    const cdx = Math.max(-CLAMP, Math.min(CLAMP, dx));
    const cdy = Math.max(-CLAMP, Math.min(CLAMP, dy));
    const page = this.requirePage(sessionId);
    await page.mouse.wheel(cdx, cdy);
    await this.settle(page);
    this.touch(sessionId);
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

  private requirePage(sessionId: string): Page {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'live') {
      throw new Error(`No active browser session for ${sessionId}`);
    }
    const page = session.pages[session.activePageIdx];
    if (!page) {
      throw new Error(`No active page for session ${sessionId}`);
    }
    return page;
  }

  private assertAiCanUse(sessionId: string, action: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`No session ${sessionId}`);
    assertBrowserToolAllowed(session, action);
  }

  /**
   * Attach per-tab listeners that feed the session console buffer and
   * clean up when a tab is closed (either by user, window.close, or
   * navigation to about:blank). Idempotent: calling twice on the same
   * page just registers duplicate handlers, which is harmless but wasteful
   * — we tag the page to prevent that.
   */
  private attachPageInstrumentation(session: InternalSession, page: Page): void {
    const pageWithTag = page as Page & { __pinai_instrumented?: boolean };
    if (pageWithTag.__pinai_instrumented) return;
    pageWithTag.__pinai_instrumented = true;

    page.on('console', (msg) => {
      const tabIndex = session.pages.indexOf(page);
      session.consoleBuffer.push({
        at: Date.now(),
        level: msg.type(),
        text: msg.text(),
        tabIndex: tabIndex < 0 ? -1 : tabIndex,
      });
      if (session.consoleBuffer.length > CONSOLE_BUFFER_MAX) {
        session.consoleBuffer.splice(0, session.consoleBuffer.length - CONSOLE_BUFFER_MAX);
      }
    });

    page.on('close', () => {
      const idx = session.pages.indexOf(page);
      if (idx < 0) return;
      session.pages.splice(idx, 1);
      if (session.activePageIdx === idx) {
        session.activePageIdx = Math.max(0, Math.min(idx, session.pages.length - 1));
      } else if (session.activePageIdx > idx) {
        session.activePageIdx -= 1;
      }
      this.logger.info(`[browserbase] Session ${session.id} tab closed (${session.pages.length} remaining)`);
    });
  }

  /** Resolve a snapshot ref back to a Playwright Locator via the aria-ref engine. */
  private resolveLocator(page: Page, sessionId: string, ref: string): Locator {
    const session = this.sessions.get(sessionId);
    if (!session?.hasSnapshotted) {
      throw new Error(`No snapshot on record. Call "snapshot" before using ref="${ref}".`);
    }
    return page.locator(`aria-ref=${ref}`);
  }

  /** Small settle window after an action so snapshot reflects the new DOM. */
  private async settle(page: Page): Promise<void> {
    await page.waitForTimeout(POST_ACTION_SETTLE_MS);
    // Best-effort: many SPAs never truly idle, so don't let that propagate.
    await page.waitForLoadState('domcontentloaded', { timeout: 2000 }).catch(() => {});
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
      takeoverReason: s.takeoverReason,
      controlUpdatedAt: s.controlUpdatedAt,
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
          // Restore whatever tabs are still open remotely; active-idx falls
          // back to 0 if the old active tab is gone. Refs from before the
          // disconnect are invalidated.
          session.pages = [...existingPages];
          if (session.activePageIdx >= session.pages.length) {
            session.activePageIdx = 0;
          }
          session.hasSnapshotted = false;
          for (const p of session.pages) this.attachPageInstrumentation(session, p);

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
