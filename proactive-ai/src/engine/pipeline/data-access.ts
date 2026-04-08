/**
 * Direct data access layer — calls @pin-ai/core domain services.
 *
 * Replaces the old pin-cli.ts bridge that routed through CLI command parsing.
 * Engine now talks to core directly: no serialization, no envelope unwrapping,
 * full type safety.
 */

import { homedir } from 'node:os';
import {
  profile,
  feedback,
  type CoreContext,
  NotFoundError,
} from '../../core/index.js';

function buildCtx(): CoreContext {
  return { env: process.env as Record<string, string | undefined>, homeDir: homedir() };
}

// ── Profile ──

export async function getDefaultProfile(): Promise<Record<string, unknown> | null> {
  try {
    return await profile.getProfile(buildCtx(), 'default') as Record<string, unknown>;
  } catch (err) {
    if (err instanceof NotFoundError) return null;
    throw err;
  }
}

export async function createDefaultProfile(input: {
  displayName: string;
  locale?: string;
  timezone?: string;
  summary?: string;
}): Promise<Record<string, unknown>> {
  return await profile.createProfile(buildCtx(), {
    id: 'default',
    ...input,
  }) as Record<string, unknown>;
}

export async function upsertGoal(input: {
  key: string;
  title: string;
  priority?: string;
}): Promise<unknown> {
  return await profile.upsertGoal(buildCtx(), input);
}

// ── Feedback ──

export async function listFeedback(opts?: {
  since?: string;
  limit?: string;
}): Promise<unknown[]> {
  return await feedback.listFeedback(buildCtx(), {
    since: opts?.since,
    limit: opts?.limit,
  });
}

export async function feedbackStats(opts?: {
  since?: string;
}): Promise<Record<string, unknown>> {
  return await feedback.statsFeedback(buildCtx(), {
    since: opts?.since,
  }) as unknown as Record<string, unknown>;
}
