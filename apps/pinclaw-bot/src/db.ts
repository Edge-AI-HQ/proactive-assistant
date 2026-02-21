import crypto from 'node:crypto';
import { createSupabasePool, requireSupabaseDbUrl } from '@pin-ai/infra-supabase';
import { config } from './config.js';
import type {
  AssistantMutableFields,
  AssistantRecord,
  AdminSessionView,
  AdminUserRecord,
  CreateAssistantInput,
  CreateUserInput,
  GatewaySessionRecord,
  LiteLLMUsageOverviewRecord,
  UserMutableFields,
  UserRecord
} from './types.js';

type Queryable = {
  query: <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ) => Promise<{ rows: T[]; rowCount: number | null }>;
};

const randomToken = (size = 24): string => crypto.randomBytes(size).toString('hex');
const nowIso = (): string => new Date().toISOString();
const PORT_ALLOC_LOCK_KEY = 319_901;

const dbUrl = requireSupabaseDbUrl(
  config.supabase.dbUrl,
  'Missing SUPABASE_DB_URL. Master bot requires Supabase Postgres connection.'
);
const pool = createSupabasePool(dbUrl, { max: 10, idleTimeoutMillis: 30_000 });

const withSchema = async (): Promise<void> => {
  // Schema ownership is migration-only under infra/supabase.
  return Promise.resolve();
};

const buildAssignments = <T extends string>(
  fields: Partial<Record<T, unknown>>,
  allowedColumns: readonly T[]
): { sql: string; values: unknown[]; columns: T[] } => {
  const entries = Object.entries(fields)
    .filter((entry): entry is [T, unknown] => allowedColumns.includes(entry[0] as T))
    .filter(([, value]) => value !== undefined);

  if (!entries.length) {
    return { sql: '', values: [], columns: [] };
  }

  const sql = entries.map(([key], idx) => `${key} = $${idx + 1}`).join(', ');
  const values = entries.map(([, value]) => value);
  const columns = entries.map(([key]) => key);
  return { sql, values, columns };
};

const fetchOne = async <T>(
  queryable: Queryable,
  sql: string,
  params: unknown[] = []
): Promise<T | undefined> => {
  const result = await queryable.query<T>(sql, params);
  return result.rows[0];
};

const userSelectColumns = `
  users.id,
  users.telegram_user_id,
  users.telegram_username,
  users.litellm_user_id,
  users.litellm_user_alias,
  COALESCE(user_runtime.runtime_ref, CONCAT('openclaw-user-', users.telegram_user_id::text)) AS container_id,
  COALESCE(user_runtime.host_port, -ABS(users.telegram_user_id)) AS container_port,
  COALESCE(user_runtime.status, 'idle') AS container_status,
  users.gateway_token,
  users.assistant_bot_token,
  users.assistant_bot_username,
  users.assistant_webhook_secret,
  users.created_at,
  users.last_active_at
`;

const userFromClause = `
  FROM users
  LEFT JOIN runtime_instances AS user_runtime
    ON user_runtime.owner_user_id = users.id
   AND user_runtime.scope = 'user'
`;

const assistantSelectColumns = `
  assistants.id,
  owners.telegram_user_id AS owner_telegram_user_id,
  assistants.assistant_bot_id,
  assistants.assistant_bot_token,
  assistants.assistant_bot_username,
  assistants.litellm_user_id,
  assistants.litellm_key_alias,
  assistants.litellm_virtual_key_encrypted,
  assistants.litellm_key_last4,
  assistants.litellm_spend_usd,
  assistants.litellm_budget_usd,
  assistants.litellm_budget_duration,
  assistants.litellm_rpm_limit,
  assistants.litellm_tpm_limit,
  assistants.litellm_last_synced_at,
  COALESCE(assistant_runtime.container_name, CONCAT('pinclaw-bot-', assistants.assistant_bot_id::text)) AS container_name,
  COALESCE(assistant_runtime.runtime_ref, CONCAT('pinclaw-bot-', assistants.assistant_bot_id::text)) AS container_id,
  COALESCE(assistant_runtime.host_port, 0) AS container_port,
  COALESCE(assistant_runtime.status, 'creating') AS container_status,
  assistants.created_at,
  assistants.updated_at
`;

const assistantFromClause = `
  FROM assistants
  JOIN users AS owners
    ON owners.id = assistants.owner_user_id
  LEFT JOIN runtime_instances AS assistant_runtime
    ON assistant_runtime.assistant_id = assistants.id
   AND assistant_runtime.scope = 'assistant'
`;

const resolveUserIdByTelegramId = async (queryable: Queryable, telegramUserId: number): Promise<number | undefined> => {
  const row = await fetchOne<{ id: number }>(queryable, 'SELECT id FROM users WHERE telegram_user_id = $1', [telegramUserId]);
  return row?.id;
};

const allocatePortInTransaction = async (queryable: Queryable): Promise<number> => {
  await queryable.query('SELECT pg_advisory_xact_lock($1)', [PORT_ALLOC_LOCK_KEY]);

  const usedResult = await queryable.query<{ host_port: number }>(
    `
      SELECT host_port
      FROM runtime_instances
      WHERE host_port BETWEEN $1 AND $2
      ORDER BY host_port ASC
    `,
    [config.container.portStart, config.container.portEnd]
  );

  const used = new Set(usedResult.rows.map((row) => row.host_port));
  for (let port = config.container.portStart; port <= config.container.portEnd; port += 1) {
    if (!used.has(port)) return port;
  }

  throw new Error('No available container ports in configured range');
};

const readAssistantRuntime = async (
  queryable: Queryable,
  assistantId: number
): Promise<
  | {
      owner_user_id: number;
      assistant_bot_id: number;
      container_name: string;
      runtime_ref: string;
      host_port: number;
      status: string;
    }
  | undefined
> => {
  return fetchOne<{
    owner_user_id: number;
    assistant_bot_id: number;
    container_name: string;
    runtime_ref: string;
    host_port: number;
    status: string;
  }>(
    queryable,
    `
      SELECT
        assistants.owner_user_id,
        assistants.assistant_bot_id,
        COALESCE(runtime_instances.container_name, CONCAT('pinclaw-bot-', assistants.assistant_bot_id::text)) AS container_name,
        COALESCE(runtime_instances.runtime_ref, CONCAT('pinclaw-bot-', assistants.assistant_bot_id::text)) AS runtime_ref,
        COALESCE(runtime_instances.host_port, 0) AS host_port,
        COALESCE(runtime_instances.status, 'creating') AS status
      FROM assistants
      LEFT JOIN runtime_instances
        ON runtime_instances.assistant_id = assistants.id
       AND runtime_instances.scope = 'assistant'
      WHERE assistants.id = $1
    `,
    [assistantId]
  );
};

const readUserRuntime = async (
  queryable: Queryable,
  telegramUserId: number
): Promise<
  | {
      user_id: number;
      telegram_user_id: number;
      container_name: string;
      runtime_ref: string;
      host_port: number;
      status: string;
    }
  | undefined
> => {
  return fetchOne<{
    user_id: number;
    telegram_user_id: number;
    container_name: string;
    runtime_ref: string;
    host_port: number;
    status: string;
  }>(
    queryable,
    `
      SELECT
        users.id AS user_id,
        users.telegram_user_id,
        COALESCE(runtime_instances.container_name, CONCAT('openclaw-user-', users.telegram_user_id::text)) AS container_name,
        COALESCE(runtime_instances.runtime_ref, CONCAT('openclaw-user-', users.telegram_user_id::text)) AS runtime_ref,
        COALESCE(runtime_instances.host_port, -ABS(users.telegram_user_id)) AS host_port,
        COALESCE(runtime_instances.status, 'idle') AS status
      FROM users
      LEFT JOIN runtime_instances
        ON runtime_instances.owner_user_id = users.id
       AND runtime_instances.scope = 'user'
      WHERE users.telegram_user_id = $1
      FOR UPDATE
    `,
    [telegramUserId]
  );
};

export const createGatewaySession = async (
  telegramUserId: number,
  ttlHours: number
): Promise<{ sessionToken: string; expiresAt: string }> => {
  await withSchema();
  const userId = await resolveUserIdByTelegramId(pool, telegramUserId);
  if (!userId) {
    throw new Error(`Cannot create gateway session: user ${telegramUserId} not found`);
  }

  const sessionToken = randomToken(32);
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString();

  await pool.query(
    `
      INSERT INTO user_sessions (user_id, session_type, session_token, expires_at)
      VALUES ($1, 'gateway', $2, $3)
    `,
    [userId, sessionToken, expiresAt]
  );

  return { sessionToken, expiresAt };
};

export const getGatewaySession = async (sessionToken: string): Promise<GatewaySessionRecord | undefined> => {
  await withSchema();
  return fetchOne<GatewaySessionRecord>(
    pool,
    `
      SELECT
        user_sessions.id,
        users.telegram_user_id,
        user_sessions.session_token,
        user_sessions.created_at,
        user_sessions.expires_at
      FROM user_sessions
      JOIN users
        ON users.id = user_sessions.user_id
      WHERE user_sessions.session_type = 'gateway'
        AND user_sessions.session_token = $1
        AND user_sessions.expires_at > $2::timestamptz
        AND user_sessions.used = FALSE
    `,
    [sessionToken, nowIso()]
  );
};

export const cleanupExpiredGatewaySessions = async (): Promise<void> => {
  await withSchema();
  await pool.query(
    "DELETE FROM user_sessions WHERE session_type = 'gateway' AND expires_at <= $1::timestamptz",
    [nowIso()]
  );
};

export const getUserByTelegramId = async (telegramUserId: number): Promise<UserRecord | undefined> => {
  await withSchema();
  return fetchOne<UserRecord>(
    pool,
    `
      SELECT ${userSelectColumns}
      ${userFromClause}
      WHERE users.telegram_user_id = $1
    `,
    [telegramUserId]
  );
};

export const getUserById = async (id: number): Promise<UserRecord | undefined> => {
  await withSchema();
  return fetchOne<UserRecord>(
    pool,
    `
      SELECT ${userSelectColumns}
      ${userFromClause}
      WHERE users.id = $1
    `,
    [id]
  );
};

export const getAssistantById = async (id: number): Promise<AssistantRecord | undefined> => {
  await withSchema();
  return fetchOne<AssistantRecord>(
    pool,
    `
      SELECT ${assistantSelectColumns}
      ${assistantFromClause}
      WHERE assistants.id = $1
    `,
    [id]
  );
};

export const getAssistantByBotToken = async (assistantBotToken: string): Promise<AssistantRecord | undefined> => {
  await withSchema();
  return fetchOne<AssistantRecord>(
    pool,
    `
      SELECT ${assistantSelectColumns}
      ${assistantFromClause}
      WHERE assistants.assistant_bot_token = $1
    `,
    [assistantBotToken]
  );
};

export const getAssistantByBotId = async (assistantBotId: number): Promise<AssistantRecord | undefined> => {
  await withSchema();
  return fetchOne<AssistantRecord>(
    pool,
    `
      SELECT ${assistantSelectColumns}
      ${assistantFromClause}
      WHERE assistants.assistant_bot_id = $1
    `,
    [assistantBotId]
  );
};

export const listAssistantsByOwnerTelegramId = async (ownerTelegramUserId: number): Promise<AssistantRecord[]> => {
  await withSchema();
  const result = await pool.query<AssistantRecord>(
    `
      SELECT ${assistantSelectColumns}
      ${assistantFromClause}
      WHERE owners.telegram_user_id = $1
      ORDER BY assistants.created_at DESC, assistants.id DESC
    `,
    [ownerTelegramUserId]
  );
  return result.rows;
};

export const listAssistants = async (): Promise<AssistantRecord[]> => {
  await withSchema();
  const result = await pool.query<AssistantRecord>(
    `
      SELECT ${assistantSelectColumns}
      ${assistantFromClause}
      ORDER BY assistants.created_at DESC, assistants.id DESC
    `
  );
  return result.rows;
};

export const listAssistantsWithLiteLLMKey = async (): Promise<AssistantRecord[]> => {
  await withSchema();
  const result = await pool.query<AssistantRecord>(
    `
      SELECT ${assistantSelectColumns}
      ${assistantFromClause}
      WHERE assistants.litellm_virtual_key_encrypted IS NOT NULL
        AND assistants.litellm_virtual_key_encrypted != ''
      ORDER BY assistants.updated_at DESC, assistants.id DESC
    `
  );
  return result.rows;
};

export const createAssistant = async (assistant: CreateAssistantInput): Promise<AssistantRecord | undefined> => {
  await withSchema();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const ownerRow = await fetchOne<{ id: number }>(
      client,
      'SELECT id FROM users WHERE telegram_user_id = $1 FOR UPDATE',
      [assistant.owner_telegram_user_id]
    );
    if (!ownerRow) {
      throw new Error(`Cannot create assistant: owner telegram user ${assistant.owner_telegram_user_id} not found`);
    }

    const containerName = assistant.container_name?.trim() || `pinclaw-bot-${assistant.assistant_bot_id}`;
    const runtimeRef = assistant.container_id?.trim() || containerName;
    const requestedPort = Number.isFinite(assistant.container_port ?? NaN)
      ? Math.trunc(assistant.container_port as number)
      : 0;
    const hostPort = requestedPort > 0 ? requestedPort : await allocatePortInTransaction(client);

    const assistantInsert = await client.query<{ id: number }>(
      `
        INSERT INTO assistants (
          owner_user_id,
          assistant_bot_id,
          assistant_bot_token,
          assistant_bot_username,
          litellm_user_id,
          litellm_key_alias,
          litellm_virtual_key_encrypted,
          litellm_key_last4,
          litellm_spend_usd,
          litellm_budget_usd,
          litellm_budget_duration,
          litellm_rpm_limit,
          litellm_tpm_limit,
          litellm_last_synced_at,
          updated_at
        ) VALUES (
          $1, $2, $3, $4,
          $5, $6, $7, $8,
          $9, $10, $11, $12,
          $13, $14, $15
        )
        RETURNING id
      `,
      [
        ownerRow.id,
        assistant.assistant_bot_id,
        assistant.assistant_bot_token,
        assistant.assistant_bot_username,
        assistant.litellm_user_id ?? null,
        assistant.litellm_key_alias ?? null,
        assistant.litellm_virtual_key_encrypted ?? null,
        assistant.litellm_key_last4 ?? null,
        assistant.litellm_spend_usd ?? 0,
        assistant.litellm_budget_usd ?? null,
        assistant.litellm_budget_duration ?? null,
        assistant.litellm_rpm_limit ?? null,
        assistant.litellm_tpm_limit ?? null,
        assistant.litellm_last_synced_at ?? null,
        nowIso()
      ]
    );

    const assistantId = assistantInsert.rows[0]?.id;
    if (!assistantId) {
      throw new Error('Failed to create assistant record');
    }

    await client.query(
      `
        INSERT INTO runtime_instances (
          owner_user_id,
          assistant_id,
          scope,
          runtime_provider,
          container_name,
          runtime_ref,
          host_port,
          status
        ) VALUES (
          $1, $2, 'assistant', $3,
          $4, $5, $6, $7
        )
      `,
      [
        ownerRow.id,
        assistantId,
        config.container.runtime,
        containerName,
        runtimeRef,
        hostPort,
        assistant.container_status ?? 'creating'
      ]
    );

    await client.query('COMMIT');

    return getAssistantById(assistantId);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const assistantDataColumns = [
  'assistant_bot_token',
  'assistant_bot_username',
  'litellm_user_id',
  'litellm_key_alias',
  'litellm_virtual_key_encrypted',
  'litellm_key_last4',
  'litellm_spend_usd',
  'litellm_budget_usd',
  'litellm_budget_duration',
  'litellm_rpm_limit',
  'litellm_tpm_limit',
  'litellm_last_synced_at'
] as const;

const assistantRuntimeColumns = ['container_name', 'container_id', 'container_port', 'container_status'] as const;

export const updateAssistant = async (
  id: number,
  fields: AssistantMutableFields
): Promise<AssistantRecord | undefined> => {
  await withSchema();

  const dataAssignments = buildAssignments(fields, assistantDataColumns);
  const runtimeAssignments = buildAssignments(fields, assistantRuntimeColumns);

  if (!dataAssignments.sql && !runtimeAssignments.sql) {
    return getAssistantById(id);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (dataAssignments.sql) {
      const updatedAtIndex = dataAssignments.values.length + 1;
      const idIndex = dataAssignments.values.length + 2;
      await client.query(
        `
          UPDATE assistants
          SET ${dataAssignments.sql}, updated_at = $${updatedAtIndex}
          WHERE id = $${idIndex}
        `,
        [...dataAssignments.values, nowIso(), id]
      );
    }

    if (runtimeAssignments.columns.length) {
      const current = await readAssistantRuntime(client, id);
      if (!current) {
        throw new Error(`Assistant ${id} not found`);
      }

      const nextContainerName =
        (fields.container_name !== undefined ? String(fields.container_name || '').trim() : current.container_name) ||
        `pinclaw-bot-${current.assistant_bot_id}`;
      const nextRuntimeRef =
        (fields.container_id !== undefined ? String(fields.container_id || '').trim() : current.runtime_ref) || nextContainerName;
      const nextHostPort =
        fields.container_port !== undefined ? Math.trunc(Number(fields.container_port) || 0) : current.host_port;
      const nextStatus =
        fields.container_status !== undefined ? String(fields.container_status || '').trim() || current.status : current.status;

      await client.query(
        `
          INSERT INTO runtime_instances (
            owner_user_id,
            assistant_id,
            scope,
            runtime_provider,
            container_name,
            runtime_ref,
            host_port,
            status,
            updated_at
          ) VALUES (
            $1, $2, 'assistant', $3,
            $4, $5, $6, $7, $8::timestamptz
          )
          ON CONFLICT (assistant_id)
          WHERE assistant_id IS NOT NULL
          DO UPDATE SET
            container_name = EXCLUDED.container_name,
            runtime_ref = EXCLUDED.runtime_ref,
            host_port = EXCLUDED.host_port,
            status = EXCLUDED.status,
            runtime_provider = EXCLUDED.runtime_provider,
            updated_at = EXCLUDED.updated_at
        `,
        [
          current.owner_user_id,
          id,
          config.container.runtime,
          nextContainerName,
          nextRuntimeRef,
          nextHostPort,
          nextStatus,
          nowIso()
        ]
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return getAssistantById(id);
};

export const getUserByAssistantBotToken = async (assistantBotToken: string): Promise<UserRecord | undefined> => {
  await withSchema();
  return fetchOne<UserRecord>(
    pool,
    `
      SELECT ${userSelectColumns}
      ${userFromClause}
      WHERE users.assistant_bot_token = $1
    `,
    [assistantBotToken]
  );
};

export const getUserByAssistantBotUsername = async (
  assistantBotUsername: string
): Promise<UserRecord | undefined> => {
  await withSchema();
  return fetchOne<UserRecord>(
    pool,
    `
      SELECT ${userSelectColumns}
      ${userFromClause}
      WHERE users.assistant_bot_username = $1
    `,
    [assistantBotUsername]
  );
};

export const listUsers = async (): Promise<UserRecord[]> => {
  await withSchema();
  const result = await pool.query<UserRecord>(
    `
      SELECT ${userSelectColumns}
      ${userFromClause}
      ORDER BY users.created_at DESC, users.id DESC
    `
  );
  return result.rows;
};

export const createUser = async (user: CreateUserInput): Promise<UserRecord | undefined> => {
  await withSchema();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const createdUser = await client.query<{ id: number }>(
      `
        INSERT INTO users (
          telegram_user_id,
          telegram_username,
          litellm_user_id,
          litellm_user_alias,
          gateway_token,
          assistant_bot_token,
          assistant_bot_username,
          assistant_webhook_secret,
          last_active_at,
          updated_at
        ) VALUES (
          $1, $2, $3, $4,
          $5, $6, $7, $8,
          $9::timestamptz, $10::timestamptz
        )
        RETURNING id
      `,
      [
        user.telegram_user_id,
        user.telegram_username ?? null,
        user.litellm_user_id ?? null,
        user.litellm_user_alias ?? null,
        user.gateway_token,
        user.assistant_bot_token ?? null,
        user.assistant_bot_username ?? null,
        user.assistant_webhook_secret ?? null,
        nowIso(),
        nowIso()
      ]
    );

    const userId = createdUser.rows[0]?.id;
    if (!userId) {
      throw new Error(`Failed to create user ${user.telegram_user_id}`);
    }

    await client.query(
      `
        INSERT INTO runtime_instances (
          owner_user_id,
          scope,
          runtime_provider,
          container_name,
          runtime_ref,
          host_port,
          status
        ) VALUES (
          $1, 'user', $2,
          $3, $4, $5, $6
        )
        ON CONFLICT (owner_user_id)
        WHERE scope = 'user'
        DO UPDATE SET
          runtime_provider = EXCLUDED.runtime_provider,
          container_name = EXCLUDED.container_name,
          runtime_ref = EXCLUDED.runtime_ref,
          host_port = EXCLUDED.host_port,
          status = EXCLUDED.status,
          updated_at = NOW()
      `,
      [
        userId,
        config.container.runtime,
        user.container_id,
        user.container_id,
        user.container_port,
        user.container_status ?? 'creating'
      ]
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return getUserByTelegramId(user.telegram_user_id);
};

const userDataColumns = [
  'telegram_username',
  'litellm_user_id',
  'litellm_user_alias',
  'gateway_token',
  'assistant_bot_token',
  'assistant_bot_username',
  'assistant_webhook_secret'
] as const;

const userRuntimeColumns = ['container_id', 'container_port', 'container_status'] as const;

export const updateUser = async (telegramUserId: number, fields: UserMutableFields): Promise<UserRecord | undefined> => {
  await withSchema();

  const dataAssignments = buildAssignments(fields, userDataColumns);
  const runtimeAssignments = buildAssignments(fields, userRuntimeColumns);

  if (!dataAssignments.sql && !runtimeAssignments.sql) {
    return getUserByTelegramId(telegramUserId);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (dataAssignments.sql) {
      const activeAtIndex = dataAssignments.values.length + 1;
      const updatedAtIndex = dataAssignments.values.length + 2;
      const userIdIndex = dataAssignments.values.length + 3;

      await client.query(
        `
          UPDATE users
          SET ${dataAssignments.sql}, last_active_at = $${activeAtIndex}::timestamptz, updated_at = $${updatedAtIndex}::timestamptz
          WHERE telegram_user_id = $${userIdIndex}
        `,
        [...dataAssignments.values, nowIso(), nowIso(), telegramUserId]
      );
    }

    if (runtimeAssignments.columns.length) {
      const current = await readUserRuntime(client, telegramUserId);
      if (!current) {
        throw new Error(`User ${telegramUserId} not found`);
      }

      const nextRuntimeRef =
        (fields.container_id !== undefined ? String(fields.container_id || '').trim() : current.runtime_ref) ||
        `openclaw-user-${telegramUserId}`;
      const nextHostPort =
        fields.container_port !== undefined ? Math.trunc(Number(fields.container_port) || 0) : current.host_port;
      const nextStatus =
        fields.container_status !== undefined ? String(fields.container_status || '').trim() || current.status : current.status;

      await client.query(
        `
          INSERT INTO runtime_instances (
            owner_user_id,
            scope,
            runtime_provider,
            container_name,
            runtime_ref,
            host_port,
            status,
            updated_at
          ) VALUES (
            $1, 'user', $2,
            $3, $4, $5, $6, $7::timestamptz
          )
          ON CONFLICT (owner_user_id)
          WHERE scope = 'user'
          DO UPDATE SET
            runtime_provider = EXCLUDED.runtime_provider,
            container_name = EXCLUDED.container_name,
            runtime_ref = EXCLUDED.runtime_ref,
            host_port = EXCLUDED.host_port,
            status = EXCLUDED.status,
            updated_at = EXCLUDED.updated_at
        `,
        [
          current.user_id,
          config.container.runtime,
          current.container_name,
          nextRuntimeRef,
          nextHostPort,
          nextStatus,
          nowIso()
        ]
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return getUserByTelegramId(telegramUserId);
};

export const touchUser = async (telegramUserId: number): Promise<UserRecord | undefined> => {
  await withSchema();
  await pool.query('UPDATE users SET last_active_at = $1::timestamptz, updated_at = $2::timestamptz WHERE telegram_user_id = $3', [
    nowIso(),
    nowIso(),
    telegramUserId
  ]);
  return getUserByTelegramId(telegramUserId);
};

export const updateUserById = async (id: number, fields: UserMutableFields): Promise<UserRecord | undefined> => {
  await withSchema();

  const existing = await getUserById(id);
  if (!existing) return undefined;

  return updateUser(existing.telegram_user_id, fields);
};

export const listUsedPorts = async (): Promise<number[]> => {
  await withSchema();
  const result = await pool.query<{ host_port: number }>(
    `
      SELECT host_port
      FROM runtime_instances
      WHERE host_port > 0
        AND (scope = 'assistant' OR status != 'idle')
    `
  );

  return result.rows.map((row) => row.host_port);
};

export const getLiteLLMUsageOverview = async (): Promise<LiteLLMUsageOverviewRecord> => {
  await withSchema();
  const result = await pool.query<LiteLLMUsageOverviewRecord>(
    `
      SELECT
        COUNT(*)::int AS assistants_with_keys,
        COALESCE(
          SUM(
            CASE
              WHEN assistants.litellm_budget_usd IS NOT NULL
               AND assistants.litellm_budget_usd > 0
               AND COALESCE(assistants.litellm_spend_usd, 0) >= assistants.litellm_budget_usd
              THEN 1
              ELSE 0
            END
          ),
          0
        )::int AS assistants_over_budget,
        COALESCE(SUM(COALESCE(assistants.litellm_spend_usd, 0)), 0) AS total_spend_usd
      FROM assistants
      WHERE assistants.litellm_virtual_key_encrypted IS NOT NULL
        AND assistants.litellm_virtual_key_encrypted != ''
    `
  );

  return (
    result.rows[0] ?? {
      assistants_with_keys: 0,
      assistants_over_budget: 0,
      total_spend_usd: 0
    }
  );
};

export const ensureAdminUser = async (
  username: string,
  passwordHash: string
): Promise<AdminUserRecord | null | undefined> => {
  await withSchema();
  if (!passwordHash) return null;

  const existing = await fetchOne<AdminUserRecord>(pool, 'SELECT * FROM admin_users WHERE username = $1', [username]);
  if (existing) return existing;

  await pool.query(
    `
      INSERT INTO admin_users (username, password_hash)
      VALUES ($1, $2)
      ON CONFLICT (username) DO NOTHING
    `,
    [username, passwordHash]
  );

  return fetchOne<AdminUserRecord>(pool, 'SELECT * FROM admin_users WHERE username = $1', [username]);
};

export const getAdminByUsername = async (username: string): Promise<AdminUserRecord | undefined> => {
  await withSchema();
  return fetchOne<AdminUserRecord>(pool, 'SELECT * FROM admin_users WHERE username = $1', [username]);
};

export const createAdminSession = async (
  adminId: number,
  ttlHours: number
): Promise<{ sessionToken: string; expiresAt: string }> => {
  await withSchema();
  const sessionToken = randomToken(32);
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString();

  await pool.query(
    `
      INSERT INTO admin_sessions (admin_id, session_token, expires_at)
      VALUES ($1, $2, $3::timestamptz)
    `,
    [adminId, sessionToken, expiresAt]
  );

  return { sessionToken, expiresAt };
};

export const getAdminSession = async (sessionToken: string): Promise<AdminSessionView | undefined> => {
  await withSchema();
  return fetchOne<AdminSessionView>(
    pool,
    `
      SELECT
        admin_sessions.id,
        admin_sessions.admin_id,
        admin_sessions.session_token,
        admin_sessions.expires_at,
        admin_users.username AS admin_username
      FROM admin_sessions
      JOIN admin_users
        ON admin_users.id = admin_sessions.admin_id
      WHERE admin_sessions.session_token = $1
        AND admin_sessions.expires_at > $2::timestamptz
    `,
    [sessionToken, nowIso()]
  );
};

export const deleteAdminSession = async (sessionToken: string): Promise<void> => {
  await withSchema();
  await pool.query('DELETE FROM admin_sessions WHERE session_token = $1', [sessionToken]);
};

export const purgeExpiredAdminSessions = async (): Promise<void> => {
  await withSchema();
  await pool.query('DELETE FROM admin_sessions WHERE expires_at <= $1::timestamptz', [nowIso()]);
};

export const createGatewayToken = (): string => randomToken(24);
