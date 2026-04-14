/**
 * Proactive AI user service — uses the unified `users` + `runtime_instances`
 * tables (migrations 001-016).
 *
 * OAuth users are identified by `users.supabase_user_id` (UUID from Supabase Auth).
 * Container state lives in `runtime_instances` with scope = 'user'.
 * The `gateway_token` lives on the `users` table (not runtime_instances).
 */

import crypto from 'node:crypto';
import { pool } from '../common/db/core.js';
import type { ProactiveUser, ProactiveContainer } from './types.js';

// ---------------------------------------------------------------------------
// User upsert / lookup
// ---------------------------------------------------------------------------

/** Upsert an OAuth user on login. Creates a new `users` row if not found. */
export async function upsertUser(params: {
  userId: string;    // Supabase UUID
  email: string;
  name?: string | undefined;
  avatarUrl?: string | undefined;
  authProvider?: string | undefined;
}): Promise<ProactiveUser> {
  const gatewayToken = crypto.randomUUID();
  const { rows } = await pool.query<ProactiveUser>(
    `INSERT INTO users (supabase_user_id, email, display_name, avatar_url, auth_provider, gateway_token)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (supabase_user_id) DO UPDATE SET
       email = COALESCE(EXCLUDED.email, users.email),
       display_name = COALESCE(EXCLUDED.display_name, users.display_name),
       avatar_url = COALESCE(EXCLUDED.avatar_url, users.avatar_url),
       auth_provider = COALESCE(EXCLUDED.auth_provider, users.auth_provider),
       last_active_at = NOW(),
       updated_at = NOW()
     RETURNING *`,
    [
      params.userId,
      params.email,
      params.name ?? null,
      params.avatarUrl ?? null,
      params.authProvider ?? null,
      gatewayToken,
    ]
  );
  return rows[0]!;
}

/** Update last_active_at (called by heartbeat endpoint). */
export async function touchUserActivity(supabaseUserId: string): Promise<void> {
  await pool.query(
    `UPDATE users SET last_active_at = NOW() WHERE supabase_user_id = $1`,
    [supabaseUserId]
  );
}

/** Get user by Supabase UUID. */
export async function getUserBySupabaseId(supabaseUserId: string): Promise<ProactiveUser | null> {
  const { rows } = await pool.query<ProactiveUser>(
    `SELECT * FROM users WHERE supabase_user_id = $1`,
    [supabaseUserId]
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Container (runtime_instances) CRUD
// ---------------------------------------------------------------------------

/**
 * Extended container info that includes the user's gateway_token
 * (which lives on the `users` table, not `runtime_instances`).
 */
export type ContainerWithToken = ProactiveContainer & { gateway_token: string };

/** Get user-scope container for a user, including gateway_token from users. */
export async function getContainerForUser(supabaseUserId: string): Promise<ContainerWithToken | null> {
  const { rows } = await pool.query<ContainerWithToken>(
    `SELECT ri.*, u.gateway_token
     FROM runtime_instances ri
     JOIN users u ON u.id = ri.owner_user_id
     WHERE u.supabase_user_id = $1
       AND ri.scope = 'user'
     LIMIT 1`,
    [supabaseUserId]
  );
  return rows[0] ?? null;
}

/** Get container by internal user ID, including gateway_token. */
export async function getContainerByInternalId(internalUserId: number): Promise<ContainerWithToken | null> {
  const { rows } = await pool.query<ContainerWithToken>(
    `SELECT ri.*, u.gateway_token
     FROM runtime_instances ri
     JOIN users u ON u.id = ri.owner_user_id
     WHERE ri.owner_user_id = $1 AND ri.scope = 'user'
     LIMIT 1`,
    [internalUserId]
  );
  return rows[0] ?? null;
}

/** Create or update a user-scope container record in runtime_instances. */
export async function upsertContainer(params: {
  internalUserId: number;
  containerName: string;
  runtimeProvider: 'fly' | 'docker';
  runtimeRef?: string;
  hostPort?: number;
  status?: string;
  metadata?: Record<string, unknown>;
}): Promise<ContainerWithToken> {
  const { rows } = await pool.query<ContainerWithToken>(
    `WITH upserted AS (
       INSERT INTO runtime_instances (owner_user_id, scope, runtime_provider, container_name, runtime_ref, host_port, status, metadata)
       VALUES ($1, 'user', $2, $3, $4, $5, $6, $7)
       ON CONFLICT (owner_user_id) WHERE scope = 'user'
       DO UPDATE SET
         container_name = EXCLUDED.container_name,
         runtime_provider = EXCLUDED.runtime_provider,
         runtime_ref = COALESCE(EXCLUDED.runtime_ref, runtime_instances.runtime_ref),
         host_port = COALESCE(EXCLUDED.host_port, runtime_instances.host_port),
         status = COALESCE(EXCLUDED.status, runtime_instances.status),
         metadata = COALESCE(EXCLUDED.metadata, runtime_instances.metadata),
         updated_at = NOW()
       RETURNING *
     )
     SELECT upserted.*, u.gateway_token
     FROM upserted
     JOIN users u ON u.id = upserted.owner_user_id`,
    [
      params.internalUserId,
      params.runtimeProvider,
      params.containerName,
      params.runtimeRef ?? null,
      params.hostPort ?? null,
      params.status ?? 'creating',
      JSON.stringify(params.metadata ?? {}),
    ]
  );
  return rows[0]!;
}

/** Update container status + optional fields. */
export async function updateContainerStatus(
  internalUserId: number,
  fields: Partial<Pick<ProactiveContainer, 'status' | 'runtime_ref' | 'metadata' | 'host_port'>>
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
  if (fields.host_port !== undefined) {
    sets.push(`host_port = $${idx++}`);
    values.push(fields.host_port);
  }

  if (sets.length === 0) return;

  values.push(internalUserId);
  await pool.query(
    `UPDATE runtime_instances SET ${sets.join(', ')}, updated_at = NOW()
     WHERE owner_user_id = $${idx} AND scope = 'user'`,
    values
  );
}

/** Touch runtime_instances.last_active_at for idle-suspend tracking. */
export async function touchContainerActivity(internalUserId: number): Promise<void> {
  await pool.query(
    `UPDATE runtime_instances SET last_active_at = NOW()
     WHERE owner_user_id = $1 AND scope = 'user'`,
    [internalUserId]
  );
}

/** Delete container record. */
export async function deleteContainer(internalUserId: number): Promise<void> {
  await pool.query(
    `DELETE FROM runtime_instances WHERE owner_user_id = $1 AND scope = 'user'`,
    [internalUserId]
  );
}

/** Delete all user data. */
export async function deleteUserAccount(supabaseUserId: string): Promise<void> {
  const user = await getUserBySupabaseId(supabaseUserId);
  if (!user) return;

  await pool.query(
    `DELETE FROM runtime_instances WHERE owner_user_id = $1`,
    [user.id]
  );

  await pool.query(`DELETE FROM users WHERE id = $1`, [user.id]);
}

// ---------------------------------------------------------------------------
// Advisory lock
// ---------------------------------------------------------------------------

export async function withUserLock<T>(
  supabaseUserId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const hash = Buffer.from(supabaseUserId.replace(/-/g, ''), 'hex');
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
  owner_user_id: number;
  runtime_ref: string;
  container_name: string;
}>> {
  const { rows } = await pool.query<{
    owner_user_id: number;
    runtime_ref: string;
    container_name: string;
  }>(
    `SELECT ri.owner_user_id, ri.runtime_ref, ri.container_name
     FROM runtime_instances ri
     WHERE ri.scope = 'user'
       AND ri.status = 'running'
       AND ri.runtime_ref IS NOT NULL
       AND ri.last_active_at IS NOT NULL
       AND ri.last_active_at < NOW() - make_interval(mins => $1)`,
    [idleMinutes]
  );
  return rows;
}
