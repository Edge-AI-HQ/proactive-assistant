/**
 * `pin tasks ...` — admin/dev surface for the background_tasks queue.
 * See docs/plans/2026-04-24-data-connector-init-tasks.mdx (Phase A).
 *
 * Subcommands:
 *   pin tasks help
 *   pin tasks list   [--type X] [--status Y[,Z]] [--limit N] [--since ISO]
 *   pin tasks show   --id ID
 *   pin tasks attempts --id ID
 *   pin tasks cancel --id ID
 *   pin tasks enqueue --type X --idempotencyKey K [--payload JSON] [--priority N] [--maxAttempts N]
 *
 * Read paths are safe; write paths (cancel/enqueue) mutate the queue and
 * are intended for human or skill-authored debugging, not for the
 * scheduler itself (which calls db.* directly).
 */
import {
  parseArgs,
  success,
  failure,
  readJsonFlag,
  readLimitFlag,
  readNumericFlag,
} from './shared.js';
import * as db from '../db.js';

const VALID_STATUSES = new Set([
  'queued', 'running', 'succeeded', 'failed',
  'timed_out', 'cancelled', 'lost', 'skipped',
]);

export async function handleTasks(args: string[]): Promise<string> {
  const { positional, flags } = parseArgs(args);
  const sub = positional[0];

  if (!sub || sub === 'help') {
    return success('tasks', 'help', {
      commands: ['list', 'show', 'attempts', 'cancel', 'enqueue'],
      examples: [
        'pin tasks list --type connector.init --limit 20',
        'pin tasks list --status queued,running',
        'pin tasks show --id <task_id>',
        'pin tasks attempts --id <task_id>',
        'pin tasks cancel --id <task_id>',
        'pin tasks enqueue --type connector.init --idempotencyKey gmail:acc-1:v1 --payload \'{"toolkit":"gmail"}\'',
      ],
    });
  }

  if (sub === 'list') {
    const limitRes = readLimitFlag(flags, 'tasks', 'list');
    if ('failure' in limitRes) return limitRes.failure;
    const status = parseStatusFlag(flags['status']);
    if (status === 'invalid') {
      return failure('tasks', 'list', 'validation',
        `Invalid --status; use comma-separated values from: ${[...VALID_STATUSES].join(', ')}`);
    }
    const tasks = await db.listBackgroundTasks({
      type: flags['type'],
      status,
      since: flags['since'],
      limit: limitRes.value ?? 50,
    });
    return success('tasks', 'list', { count: tasks.length, tasks });
  }

  if (sub === 'show') {
    const id = flags['id']?.trim();
    if (!id) return failure('tasks', 'show', 'validation', 'Missing --id');
    const task = await db.getBackgroundTask(id);
    if (!task) return failure('tasks', 'show', 'not_found', `Task ${id} not found`);
    return success('tasks', 'show', { task });
  }

  if (sub === 'attempts') {
    const id = flags['id']?.trim();
    if (!id) return failure('tasks', 'attempts', 'validation', 'Missing --id');
    // attempts() returns [] for unknown ids — caller can't distinguish from
    // a brand-new task that hasn't been claimed yet, so verify the task
    // exists first to give a useful error.
    const task = await db.getBackgroundTask(id);
    if (!task) return failure('tasks', 'attempts', 'not_found', `Task ${id} not found`);
    const attempts = await db.listTaskAttempts(id);
    return success('tasks', 'attempts', { taskId: id, count: attempts.length, attempts });
  }

  if (sub === 'cancel') {
    const id = flags['id']?.trim();
    if (!id) return failure('tasks', 'cancel', 'validation', 'Missing --id');
    const task = await db.getBackgroundTask(id);
    if (!task) return failure('tasks', 'cancel', 'not_found', `Task ${id} not found`);
    const ok = await db.cancelBackgroundTask(id);
    if (!ok) {
      return failure('tasks', 'cancel', 'conflict',
        `Task ${id} is already in terminal state (${task.status}); nothing to cancel`);
    }
    return success('tasks', 'cancel', { id, status: 'cancelled' });
  }

  if (sub === 'enqueue') {
    const type = flags['type']?.trim();
    const idempotencyKey = flags['idempotencyKey']?.trim() ?? flags['idempotency-key']?.trim();
    if (!type) return failure('tasks', 'enqueue', 'validation', 'Missing --type');
    if (!idempotencyKey) {
      return failure('tasks', 'enqueue', 'validation', 'Missing --idempotencyKey');
    }
    const payloadRes = readJsonFlag<Record<string, unknown>>(flags, 'payload', 'tasks', 'enqueue');
    if ('failure' in payloadRes) return payloadRes.failure;
    const priorityRes = readNumericFlag(flags, ['priority'], 'tasks', 'enqueue');
    if ('failure' in priorityRes) return priorityRes.failure;
    const maxAttemptsRes = readNumericFlag(flags, ['maxAttempts', 'max-attempts'], 'tasks', 'enqueue');
    if ('failure' in maxAttemptsRes) return maxAttemptsRes.failure;

    const result = await db.enqueueBackgroundTask({
      type,
      idempotencyKey,
      payload: payloadRes.value ?? {},
      priority: priorityRes.value,
      maxAttempts: maxAttemptsRes.value,
      runAfter: flags['runAfter'] ?? flags['run-after'],
    });
    return success('tasks', 'enqueue', {
      id: result.task.id,
      created: result.created,
      task: result.task,
    });
  }

  return failure('tasks', sub ?? 'unknown', 'validation',
    `Unknown tasks command: ${sub}`,
    'Available: list, show, attempts, cancel, enqueue');
}

function parseStatusFlag(raw: string | undefined): db.BackgroundTaskStatus | db.BackgroundTaskStatus[] | undefined | 'invalid' {
  if (!raw) return undefined;
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;
  for (const p of parts) {
    if (!VALID_STATUSES.has(p)) return 'invalid';
  }
  return parts.length === 1
    ? parts[0]! as db.BackgroundTaskStatus
    : parts as db.BackgroundTaskStatus[];
}
