/**
 * BackgroundTaskScheduler — single-process task runner.
 *
 * Drives the background_tasks queue:
 *   - reaper sweep on every tick (recovers expired leases)
 *   - claim next due task (filtered by registered types so an unknown
 *     `type` doesn't get picked up and immediately fail)
 *   - invoke the registered handler with a lease-aware context
 *   - persist the terminal state (completeBackgroundTask / failBackgroundTask)
 *
 * Deliberately simple for Phase A — no SQL lock, no multi-claim batch, no
 * cross-worker coordination. The plugin runs single-process per user
 * container; an in-process Mutex on tick() is enough. See review notes
 * in docs/plans/2026-04-24-data-connector-init-tasks.mdx evaluation.
 *
 * The scheduler does NOT auto-start: callers must call .start(). The plugin
 * starts it by default unless BACKGROUND_AUTO_LOOP_TASKS_ENABLED is explicitly
 * disabled.
 */
import * as db from '../db.js';

export interface TaskLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface TaskHandlerContext {
  task: db.BackgroundTaskRow;
  attempt: db.TaskAttemptRow;
  /**
   * Renew the lease, optionally update progress. Returns false if the
   * lease has been lost — the handler MUST stop writing immediately.
   *
   * Internally extends by `leaseDurationMs` (the scheduler's default)
   * unless overridden per call.
   */
  heartbeat(progress?: Record<string, unknown>, opts?: { leaseDurationMs?: number }): Promise<boolean>;
  logger: TaskLogger;
}

export interface TaskHandlerResult {
  status: 'succeeded' | 'failed' | 'skipped';
  result?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
}

export type TaskHandler = (ctx: TaskHandlerContext) => Promise<TaskHandlerResult>;

export interface BackgroundTaskSchedulerConfig {
  /** Identifies this worker in lease_owner / task_attempts.worker_id. */
  workerId: string;
  /** Default 60 000 ms. */
  tickIntervalMs?: number;
  /** Default 60 000 ms. Lease length stamped at claim + every heartbeat. */
  leaseDurationMs?: number;
  /** Default 30 000 ms. Backoff added when reaper requeues a stale task. */
  recoveryBackoffMs?: number;
  logger?: TaskLogger;
}

export interface TickReport {
  recoveredRequeued: number;
  recoveredTimedOut: number;
  ranTaskId: string | null;
  ranTaskType: string | null;
  ranStatus: 'succeeded' | 'failed' | 'skipped' | null;
  /** True if the tick stopped because no handler is registered for the claimed task. */
  noHandlerForType: string | null;
}

const NOOP_LOGGER: TaskLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const MAX_ERROR_MESSAGE_LEN = 1000;

function truncateError(msg: string | undefined): string {
  const safe = (msg ?? '').toString();
  return safe.length > MAX_ERROR_MESSAGE_LEN
    ? safe.slice(0, MAX_ERROR_MESSAGE_LEN - 3) + '...'
    : safe;
}

export class BackgroundTaskScheduler {
  private readonly handlers = new Map<string, TaskHandler>();
  private readonly logger: TaskLogger;
  private readonly tickIntervalMs: number;
  private readonly leaseDurationMs: number;
  private readonly recoveryBackoffMs: number;
  private readonly workerId: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** In-process serialization — no two ticks ever overlap in this process. */
  private tickInFlight = false;
  /** Resolves the moment the in-flight tick finishes; null when idle. */
  private tickInFlightPromise: Promise<unknown> | null = null;
  private stopping = false;

  constructor(cfg: BackgroundTaskSchedulerConfig) {
    if (!cfg.workerId || !cfg.workerId.trim()) {
      throw new Error('BackgroundTaskScheduler: workerId is required');
    }
    this.workerId = cfg.workerId;
    this.logger = cfg.logger ?? NOOP_LOGGER;
    this.tickIntervalMs = cfg.tickIntervalMs ?? 60_000;
    this.leaseDurationMs = cfg.leaseDurationMs ?? 60_000;
    this.recoveryBackoffMs = cfg.recoveryBackoffMs ?? 30_000;
  }

  registerHandler(type: string, handler: TaskHandler): void {
    if (!type || !type.trim()) {
      throw new Error('registerHandler: type is required');
    }
    if (this.handlers.has(type)) {
      throw new Error(`registerHandler: duplicate handler for ${type}`);
    }
    this.handlers.set(type, handler);
  }

  hasHandler(type: string): boolean {
    return this.handlers.has(type);
  }

  registeredTypes(): string[] {
    return [...this.handlers.keys()].sort();
  }

  /** Begin periodic tick. No-op if already running. */
  start(): void {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        this.logger.error(`[bg-task-scheduler] tick crashed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      });
    }, this.tickIntervalMs);
    // Don't keep the Node event loop alive just for the scheduler — the
    // process should exit cleanly if everything else is idle.
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** Stop the periodic tick. Awaits any in-flight tick to finish. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.tickInFlightPromise) {
      try { await this.tickInFlightPromise; } catch { /* logged below */ }
    }
  }

  /**
   * Wake-up: call after enqueue to start a tick immediately instead of
   * waiting up to tickIntervalMs. Safe to call concurrently — overlapping
   * wakes coalesce because tick() short-circuits when a tick is in flight.
   */
  wake(): void {
    if (this.stopping) return;
    void this.tick().catch((err) => {
      this.logger.error(`[bg-task-scheduler] wake tick crashed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /**
   * One scheduler tick. Public for tests + enqueue-wake. If a tick is
   * already in flight, returns the in-flight promise so callers don't
   * accidentally race two ticks.
   */
  async tick(): Promise<TickReport> {
    if (this.tickInFlight) {
      // Callers that want serial behavior wait on the running tick;
      // they get an empty report (the in-flight tick is doing the work).
      await this.tickInFlightPromise;
      return {
        recoveredRequeued: 0,
        recoveredTimedOut: 0,
        ranTaskId: null,
        ranTaskType: null,
        ranStatus: null,
        noHandlerForType: null,
      };
    }
    this.tickInFlight = true;
    const promise = this.runTickOnce();
    this.tickInFlightPromise = promise;
    try {
      return await promise;
    } finally {
      this.tickInFlight = false;
      this.tickInFlightPromise = null;
    }
  }

  private async runTickOnce(): Promise<TickReport> {
    const report: TickReport = {
      recoveredRequeued: 0,
      recoveredTimedOut: 0,
      ranTaskId: null,
      ranTaskType: null,
      ranStatus: null,
      noHandlerForType: null,
    };

    // 1. Reaper first — frees up tasks held by dead workers so the claim
    //    below can pick them up on the same tick.
    try {
      const recovery = await db.recoverStaleBackgroundTasks({
        backoffMs: this.recoveryBackoffMs,
      });
      report.recoveredRequeued = recovery.requeued;
      report.recoveredTimedOut = recovery.timedOut;
      if (recovery.requeued > 0 || recovery.timedOut > 0) {
        this.logger.warn(
          `[bg-task-scheduler] reaper: requeued=${recovery.requeued} timed_out=${recovery.timedOut}`,
        );
      }
    } catch (err) {
      this.logger.error(`[bg-task-scheduler] reaper failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 2. Claim the next due task. Filter by registered types so we don't
    //    burn an attempt on something we can't possibly handle.
    const types = this.registeredTypes();
    if (types.length === 0) {
      // No handlers wired up yet — nothing to do. Common during early boot.
      return report;
    }

    const claim = await db.claimNextDueBackgroundTask({
      workerId: this.workerId,
      leaseDurationMs: this.leaseDurationMs,
      types,
    });
    if (!claim) return report;

    const handler = this.handlers.get(claim.task.type);
    if (!handler) {
      // Defensive — shouldn't happen because we filtered by registeredTypes,
      // but a race between registerHandler and claim could leave us here.
      report.noHandlerForType = claim.task.type;
      await db.failBackgroundTask({
        id: claim.task.id,
        leaseToken: claim.task.lease_token!,
        errorCode: 'no_handler',
        errorMessage: `No handler registered for task type ${claim.task.type}`,
      });
      return report;
    }

    report.ranTaskId = claim.task.id;
    report.ranTaskType = claim.task.type;

    const ctx: TaskHandlerContext = {
      task: claim.task,
      attempt: claim.attempt,
      logger: this.logger,
      heartbeat: (progress, opts) =>
        db.heartbeatBackgroundTask({
          id: claim.task.id,
          leaseToken: claim.task.lease_token!,
          leaseDurationMs: opts?.leaseDurationMs ?? this.leaseDurationMs,
          progress,
        }),
    };

    let result: TaskHandlerResult;
    try {
      result = await handler(ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[bg-task-scheduler] handler ${claim.task.type} threw: ${err instanceof Error ? err.stack ?? message : message}`,
      );
      result = {
        status: 'failed',
        errorCode: 'handler_threw',
        errorMessage: truncateError(message),
      };
    }

    if (result.status === 'succeeded' || result.status === 'skipped') {
      // 'skipped' is reported as succeeded with result.skipped=true so we
      // don't have to widen the DB enum's terminal-success states.
      const finalResult = result.status === 'skipped'
        ? { ...(result.result ?? {}), skipped: true }
        : (result.result ?? {});
      const ok = await db.completeBackgroundTask({
        id: claim.task.id,
        leaseToken: claim.task.lease_token!,
        result: finalResult,
      });
      if (ok) {
        report.ranStatus = result.status;
      } else {
        // Lost the lease before we could persist success — reaper will
        // discover and reattempt. Already logged by heartbeat path.
        this.logger.warn(
          `[bg-task-scheduler] task ${claim.task.id} succeeded but lease was lost; reaper will retry`,
        );
      }
    } else {
      const failed = await db.failBackgroundTask({
        id: claim.task.id,
        leaseToken: claim.task.lease_token!,
        errorCode: result.errorCode ?? 'handler_failed',
        errorMessage: truncateError(result.errorMessage ?? 'unspecified failure'),
      });
      if (failed) {
        report.ranStatus = 'failed';
      } else {
        this.logger.warn(
          `[bg-task-scheduler] task ${claim.task.id} failed but lease was lost; reaper will reconcile`,
        );
      }
    }

    return report;
  }
}
