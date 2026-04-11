/**
 * Proactive AI user service — upsert on login, heartbeat, container lookup.
 */

import { pool } from '../common/db/core.js';
import type { ProactiveUser, ProactiveContainer } from './types.js';

/** Upsert a user on login (ADR-2: id = auth.users.id). */
export async function upsertUser(params: {
  userId: string;
  email: string;
  name?: string | undefined;
  avatarUrl?: string | undefined;
}): Promise<ProactiveUser> {
  const { rows } = await pool.query<ProactiveUser>(
    `INSERT INTO proactive_users (id, email, name, avatar_url)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET
       email = EXCLUDED.email,
       name = COALESCE(EXCLUDED.name, proactive_users.name),
       avatar_url = COALESCE(EXCLUDED.avatar_url, proactive_users.avatar_url),
       last_active_at = NOW(),
       updated_at = NOW()
     RETURNING *`,
    [params.userId, params.email, params.name ?? null, params.avatarUrl ?? null]
  );
  return rows[0]!;
}

/** Update last_active_at (called by heartbeat endpoint). */
export async function touchUserActivity(userId: string): Promise<void> {
  await pool.query(
    `UPDATE proactive_users SET last_active_at = NOW() WHERE id = $1`,
    [userId]
  );
}

/** Get user by ID. */
export async function getUserById(userId: string): Promise<ProactiveUser | null> {
  const { rows } = await pool.query<ProactiveUser>(
    `SELECT * FROM proactive_users WHERE id = $1`,
    [userId]
  );
  return rows[0] ?? null;
}

/** Get container for user. */
export async function getContainerForUser(userId: string): Promise<ProactiveContainer | null> {
  const { rows } = await pool.query<ProactiveContainer>(
    `SELECT * FROM proactive_containers WHERE user_id = $1`,
    [userId]
  );
  return rows[0] ?? null;
}

/** Create or update container record. */
export async function upsertContainer(params: {
  userId: string;
  containerName: string;
  runtimeProvider: 'fly' | 'docker';
  gatewayToken: string;
  runtimeRef?: string;
  status?: string;
  metadata?: Record<string, unknown>;
}): Promise<ProactiveContainer> {
  const { rows } = await pool.query<ProactiveContainer>(
    `INSERT INTO proactive_containers (user_id, container_name, runtime_provider, gateway_token, runtime_ref, status, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id) DO UPDATE SET
       container_name = EXCLUDED.container_name,
       runtime_provider = EXCLUDED.runtime_provider,
       gateway_token = COALESCE(proactive_containers.gateway_token, EXCLUDED.gateway_token),
       runtime_ref = COALESCE(EXCLUDED.runtime_ref, proactive_containers.runtime_ref),
       status = COALESCE(EXCLUDED.status, proactive_containers.status),
       metadata = COALESCE(EXCLUDED.metadata, proactive_containers.metadata),
       updated_at = NOW()
     RETURNING *`,
    [
      params.userId,
      params.containerName,
      params.runtimeProvider,
      params.gatewayToken,
      params.runtimeRef ?? null,
      params.status ?? 'creating',
      JSON.stringify(params.metadata ?? {}),
    ]
  );
  return rows[0]!;
}

/** Update container status + optional fields. */
export async function updateContainerStatus(
  userId: string,
  fields: Partial<Pick<ProactiveContainer, 'status' | 'runtime_ref' | 'metadata'>>
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (fields.status !== undefined) {
    sets.push(`status = $${idx++}`);
    values.push(fields.status);
  }
  if (fields.runtime_ref !== undefined) {
    sets.push(`runtime_ref = $${idx++}`);
    values.push(fields.runtime_ref);
  }
  if (fields.metadata !== undefined) {
    sets.push(`metadata = $${idx++}`);
    values.push(JSON.stringify(fields.metadata));
  }

  if (sets.length === 0) return;

  values.push(userId);
  await pool.query(
    `UPDATE proactive_containers SET ${sets.join(', ')}, updated_at = NOW() WHERE user_id = $${idx}`,
    values
  );
}

/** Delete container record (on user deletion or container destroy). */
export async function deleteContainer(userId: string): Promise<void> {
  await pool.query(`DELETE FROM proactive_containers WHERE user_id = $1`, [userId]);
}

/**
 * Acquire a per-user advisory lock, run the callback, then release.
 * Uses pg_advisory_xact_lock scoped to a transaction so the lock is
 * automatically released on commit/rollback — no risk of leaked locks.
 *
 * This serializes container creation per user across all API machines.
 */
export async function withUserLock<T>(
  userId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Hash userId to a bigint for advisory lock key.
    // Use two int4 args: a fixed namespace + hash of userId.
    const hash = Buffer.from(userId.replace(/-/g, ''), 'hex');
    const lockKey = hash.readInt32BE(0);
    await client.query('SELECT pg_advisory_xact_lock(42, $1)', [lockKey]);
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** List idle containers for suspend cron. */
export async function listIdleContainers(idleMinutes: number): Promise<Array<{
  user_id: string;
  runtime_ref: string;
  container_name: string;
}>> {
  const { rows } = await pool.query<{
    user_id: string;
    runtime_ref: string;
    container_name: string;
  }>(
    `SELECT c.user_id, c.runtime_ref, c.container_name
     FROM proactive_containers c
     JOIN proactive_users u ON u.id = c.user_id
     WHERE c.status = 'running'
       AND c.runtime_ref IS NOT NULL
       AND u.last_active_at < NOW() - make_interval(mins => $1)`,
    [idleMinutes]
  );
  return rows;
}
