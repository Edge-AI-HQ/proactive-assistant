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
  cards,
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

export async function listRecentGeneratedCards(opts?: {
  since?: string;
  limit?: string;
  basket?: string;
}): Promise<unknown[]> {
  return await cards.listRecentGeneratedCards(buildDefaultCtx(), {
    since: opts?.since,
    limit: opts?.limit,
    basket: opts?.basket,
  });
}
