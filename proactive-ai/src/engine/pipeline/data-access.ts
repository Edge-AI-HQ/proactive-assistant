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
  personal,
  push,
  world,
  type CoreContext,
  NotFoundError,
} from '../../core/index.js';

/**
 * Build a default CoreContext rooted at the canonical app directory.
 * Shared by engine handlers and pipeline code.
 */
export function buildDefaultCtx(): CoreContext {
  return { env: process.env as Record<string, string | undefined>, homeDir: homedir() };
}

// ── Profile ──

export async function getDefaultProfile(): Promise<Record<string, unknown> | null> {
  try {
    return await profile.getProfile(buildDefaultCtx(), 'default') as Record<string, unknown>;
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
  return await profile.createProfile(buildDefaultCtx(), {
    id: 'default',
    ...input,
  }) as Record<string, unknown>;
}

export async function upsertGoal(input: {
  key: string;
  title: string;
  priority?: string;
}): Promise<unknown> {
  return await profile.upsertGoal(buildDefaultCtx(), input);
}

export async function getDefaultProfileFacts(): Promise<Record<string, unknown>> {
  try {
    return await profile.getFacts(buildDefaultCtx()) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof NotFoundError) return {};
    throw err;
  }
}

export async function getDefaultProfilePreferences(): Promise<Record<string, unknown>> {
  try {
    return await profile.getPreferences(buildDefaultCtx()) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof NotFoundError) return {};
    throw err;
  }
}

export async function getDefaultProfileGoals(): Promise<unknown[]> {
  try {
    return await profile.listGoals(buildDefaultCtx());
  } catch (err) {
    if (err instanceof NotFoundError) return [];
    throw err;
  }
}

export async function getDefaultProfileConstraints(): Promise<Record<string, unknown>> {
  try {
    return await profile.getConstraints(buildDefaultCtx()) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof NotFoundError) return {};
    throw err;
  }
}

export async function getDefaultProfileSnapshot(): Promise<Record<string, unknown> | null> {
  try {
    return await profile.buildProfileSnapshot(buildDefaultCtx(), {
      id: 'default',
      view: 'ranking',
    }) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof NotFoundError) return null;
    throw err;
  }
}

// ── Feedback ──

export async function listFeedback(opts?: {
  since?: string;
  limit?: string;
}): Promise<unknown[]> {
  return await feedback.listFeedback(buildDefaultCtx(), {
    since: opts?.since,
    limit: opts?.limit,
  });
}

export async function feedbackStats(opts?: {
  since?: string;
}): Promise<Record<string, unknown>> {
  return await feedback.statsFeedback(buildDefaultCtx(), {
    since: opts?.since,
  }) as unknown as Record<string, unknown>;
}

export async function listFeedbackSummary(opts?: {
  since?: string;
  limit?: string;
}): Promise<unknown[]> {
  return await feedback.listFeedback(buildDefaultCtx(), {
    since: opts?.since,
    limit: opts?.limit ?? '20',
  });
}

export async function listPushHistorySummary(opts?: {
  since?: string;
  limit?: string;
}): Promise<unknown[]> {
  return await push.listPushHistory(buildDefaultCtx(), {
    since: opts?.since,
    limit: opts?.limit ?? '20',
  });
}

export async function getPersonalStatus(): Promise<Record<string, unknown>> {
  return await personal.status(buildDefaultCtx()) as Record<string, unknown>;
}

export async function listPersonalConnections(): Promise<unknown[]> {
  return await personal.listConnections(buildDefaultCtx());
}

export async function shortlistWorldItemsForDefaultProfile(limit = 10): Promise<unknown[]> {
  try {
    return await world.shortlistWorldItems(buildDefaultCtx(), {
      profileId: 'default',
      limit: String(limit),
    });
  } catch (err) {
    if (err instanceof NotFoundError) return [];
    throw err;
  }
}
