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
  MessageLogRecord,
  TokenUsageLedgerInput,
  TokenUsageLedgerRecord,
  UsageOverviewRecord,
  UserMutableFields,
  UserRecord,
  UserUsageTotalsRecord,
  UserWithUsageRecord
} from './types.js';

type Queryable = {
  query: <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ) => Promise<{ rows: T[]; rowCount: number | null }>;
};

const randomToken = (size = 24): string => crypto.randomBytes(size).toString('hex');
const nowIso = (): string => new Date().toISOString();

const dbUrl = requireSupabaseDbUrl(
  config.supabase.dbUrl,
  'Missing SUPABASE_DB_URL. Master bot requires Supabase Postgres connection.'
);
const pool = createSupabasePool(dbUrl, { max: 10, idleTimeoutMillis: 30_000 });
const withSchema = async (): Promise<void> => {
  // Schema ownership is migration-only under infra/supabase.
  return Promise.resolve();
};

const emptyUsageTotals = (telegramUserId: number): UserUsageTotalsRecord => ({
  telegram_user_id: telegramUserId,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  total_tokens: 0,
  total_cost_usd: 0,
  updated_at: nowIso()
});

const normalizeTokenValue = (value: number): number => {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
};

const normalizeCostValue = (value: number): number => {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
};

const buildAssignments = <T extends string>(
  fields: Partial<Record<T, unknown>>,
  allowedColumns: readonly T[]
): { sql: string; values: unknown[] } => {
  const entries = Object.entries(fields)
    .filter((entry): entry is [T, unknown] => allowedColumns.includes(entry[0] as T))
    .filter(([, value]) => value !== undefined);

  if (!entries.length) {
    return { sql: '', values: [] };
  }

  const sql = entries.map(([key], idx) => `${key} = $${idx + 1}`).join(', ');
  const values = entries.map(([, value]) => value);
  return { sql, values };
};

const fetchOne = async <T>(
  queryable: Queryable,
  sql: string,
  params: unknown[] = []
): Promise<T | undefined> => {
  const result = await queryable.query<T>(sql, params);
  return result.rows[0];
};

export const createGatewaySession = async (
  telegramUserId: number,
  ttlHours: number
): Promise<{ sessionToken: string; expiresAt: string }> => {
  await withSchema();
  const sessionToken = randomToken(32);
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString();

  await pool.query(
    `
      INSERT INTO gateway_sessions (telegram_user_id, session_token, expires_at)
      VALUES ($1, $2, $3)
    `,
    [telegramUserId, sessionToken, expiresAt]
  );

  return { sessionToken, expiresAt };
};

export const getGatewaySession = async (sessionToken: string): Promise<GatewaySessionRecord | undefined> => {
  await withSchema();
  return fetchOne<GatewaySessionRecord>(
    pool,
    `
      SELECT *
      FROM gateway_sessions
      WHERE session_token = $1
        AND expires_at > $2::timestamptz
    `,
    [sessionToken, nowIso()]
  );
};

export const cleanupExpiredGatewaySessions = async (): Promise<void> => {
  await withSchema();
  await pool.query('DELETE FROM gateway_sessions WHERE expires_at <= $1::timestamptz', [nowIso()]);
};

export const getUserByTelegramId = async (telegramUserId: number): Promise<UserRecord | undefined> => {
  await withSchema();
  return fetchOne<UserRecord>(pool, 'SELECT * FROM users WHERE telegram_user_id = $1', [telegramUserId]);
};

export const getUserById = async (id: number): Promise<UserRecord | undefined> => {
  await withSchema();
  return fetchOne<UserRecord>(pool, 'SELECT * FROM users WHERE id = $1', [id]);
};

export const getAssistantById = async (id: number): Promise<AssistantRecord | undefined> => {
  await withSchema();
  return fetchOne<AssistantRecord>(pool, 'SELECT * FROM assistants WHERE id = $1', [id]);
};

export const getAssistantByBotToken = async (assistantBotToken: string): Promise<AssistantRecord | undefined> => {
  await withSchema();
  return fetchOne<AssistantRecord>(pool, 'SELECT * FROM assistants WHERE assistant_bot_token = $1', [assistantBotToken]);
};

export const getAssistantByBotId = async (assistantBotId: number): Promise<AssistantRecord | undefined> => {
  await withSchema();
  return fetchOne<AssistantRecord>(pool, 'SELECT * FROM assistants WHERE assistant_bot_id = $1', [assistantBotId]);
};

export const listAssistantsByOwnerTelegramId = async (ownerTelegramUserId: number): Promise<AssistantRecord[]> => {
  await withSchema();
  const result = await pool.query<AssistantRecord>(
    `
      SELECT *
      FROM assistants
      WHERE owner_telegram_user_id = $1
      ORDER BY created_at DESC, id DESC
    `,
    [ownerTelegramUserId]
  );
  return result.rows;
};

export const listAssistants = async (): Promise<AssistantRecord[]> => {
  await withSchema();
  const result = await pool.query<AssistantRecord>(
    `
      SELECT *
      FROM assistants
      ORDER BY created_at DESC, id DESC
    `
  );
  return result.rows;
};

export const listAssistantsWithLiteLLMKey = async (): Promise<AssistantRecord[]> => {
  await withSchema();
  const result = await pool.query<AssistantRecord>(
    `
      SELECT *
      FROM assistants
      WHERE litellm_virtual_key_encrypted IS NOT NULL
        AND litellm_virtual_key_encrypted != ''
      ORDER BY updated_at DESC, id DESC
    `
  );
  return result.rows;
};

export const createAssistant = async (assistant: CreateAssistantInput): Promise<AssistantRecord | undefined> => {
  await withSchema();

  await pool.query(
    `
      INSERT INTO assistants (
        owner_telegram_user_id,
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
        container_name,
        container_id,
        container_port,
        container_status,
        updated_at
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7, $8,
        $9, $10, $11, $12,
        $13, $14, $15, $16,
        $17, $18, $19
      )
    `,
    [
      assistant.owner_telegram_user_id,
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
      assistant.container_name,
      assistant.container_id,
      assistant.container_port,
      assistant.container_status ?? 'creating',
      nowIso()
    ]
  );

  return getAssistantByBotId(assistant.assistant_bot_id);
};

const assistantMutableColumns = [
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
  'litellm_last_synced_at',
  'container_name',
  'container_id',
  'container_port',
  'container_status'
] as const;

export const updateAssistant = async (
  id: number,
  fields: AssistantMutableFields
): Promise<AssistantRecord | undefined> => {
  await withSchema();
  const assignments = buildAssignments(fields, assistantMutableColumns);
  if (!assignments.sql) {
    return getAssistantById(id);
  }

  const updatedAtIndex = assignments.values.length + 1;
  const idIndex = assignments.values.length + 2;
  await pool.query(
    `
      UPDATE assistants
      SET ${assignments.sql}, updated_at = $${updatedAtIndex}
      WHERE id = $${idIndex}
    `,
    [...assignments.values, nowIso(), id]
  );

  return getAssistantById(id);
};

export const getUserByAssistantBotToken = async (assistantBotToken: string): Promise<UserRecord | undefined> => {
  await withSchema();
  return fetchOne<UserRecord>(pool, 'SELECT * FROM users WHERE assistant_bot_token = $1', [assistantBotToken]);
};

export const getUserByAssistantBotUsername = async (
  assistantBotUsername: string
): Promise<UserRecord | undefined> => {
  await withSchema();
  return fetchOne<UserRecord>(pool, 'SELECT * FROM users WHERE assistant_bot_username = $1', [assistantBotUsername]);
};

export const listUsers = async (): Promise<UserRecord[]> => {
  await withSchema();
  const result = await pool.query<UserRecord>('SELECT * FROM users ORDER BY created_at DESC, id DESC');
  return result.rows;
};

export const createUser = async (user: CreateUserInput): Promise<UserRecord | undefined> => {
  await withSchema();

  await pool.query(
    `
      INSERT INTO users (
        telegram_user_id,
        telegram_username,
        litellm_user_id,
        litellm_user_alias,
        container_id,
        container_port,
        container_status,
        gateway_token,
        assistant_bot_token,
        assistant_bot_username,
        assistant_webhook_secret,
        last_active_at
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7, $8,
        $9, $10, $11, $12
      )
    `,
    [
      user.telegram_user_id,
      user.telegram_username ?? null,
      user.litellm_user_id ?? null,
      user.litellm_user_alias ?? null,
      user.container_id,
      user.container_port,
      user.container_status ?? 'creating',
      user.gateway_token,
      user.assistant_bot_token ?? null,
      user.assistant_bot_username ?? null,
      user.assistant_webhook_secret ?? null,
      nowIso()
    ]
  );

  return getUserByTelegramId(user.telegram_user_id);
};

const userMutableColumns = [
  'telegram_username',
  'litellm_user_id',
  'litellm_user_alias',
  'container_id',
  'container_port',
  'container_status',
  'gateway_token',
  'assistant_bot_token',
  'assistant_bot_username',
  'assistant_webhook_secret'
] as const;

export const updateUser = async (telegramUserId: number, fields: UserMutableFields): Promise<UserRecord | undefined> => {
  await withSchema();
  const assignments = buildAssignments(fields, userMutableColumns);
  if (!assignments.sql) {
    return getUserByTelegramId(telegramUserId);
  }

  const activeAtIndex = assignments.values.length + 1;
  const userIdIndex = assignments.values.length + 2;

  await pool.query(
    `
      UPDATE users
      SET ${assignments.sql}, last_active_at = $${activeAtIndex}
      WHERE telegram_user_id = $${userIdIndex}
    `,
    [...assignments.values, nowIso(), telegramUserId]
  );

  return getUserByTelegramId(telegramUserId);
};

export const touchUser = async (telegramUserId: number): Promise<UserRecord | undefined> => {
  await withSchema();
  await pool.query(
    'UPDATE users SET last_active_at = $1::timestamptz WHERE telegram_user_id = $2',
    [nowIso(), telegramUserId]
  );
  return getUserByTelegramId(telegramUserId);
};

export const updateUserById = async (id: number, fields: UserMutableFields): Promise<UserRecord | undefined> => {
  await withSchema();
  const assignments = buildAssignments(fields, userMutableColumns);
  if (!assignments.sql) {
    return getUserById(id);
  }

  const idIndex = assignments.values.length + 1;
  await pool.query(
    `
      UPDATE users
      SET ${assignments.sql}
      WHERE id = $${idIndex}
    `,
    [...assignments.values, id]
  );

  return getUserById(id);
};

export const listUsedPorts = async (): Promise<number[]> => {
  await withSchema();
  const result = await pool.query<{ container_port: number }>(
    `
      SELECT container_port
      FROM users
      WHERE container_port > 0
        AND COALESCE(container_status, '') != 'idle'
      UNION
      SELECT container_port
      FROM assistants
      WHERE container_port > 0
    `
  );

  return result.rows.map((row: { container_port: number }) => row.container_port);
};

export const logMessage = async (telegramUserId: number, direction: string, messageText: string): Promise<void> => {
  await withSchema();
  await pool.query(
    `
      INSERT INTO message_logs (telegram_user_id, direction, message_text)
      VALUES ($1, $2, $3)
    `,
    [telegramUserId, direction, messageText]
  );
};

export const listMessageLogs = async (telegramUserId: number, limit = 20): Promise<MessageLogRecord[]> => {
  await withSchema();
  const result = await pool.query<MessageLogRecord>(
    `
      SELECT *
      FROM message_logs
      WHERE telegram_user_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2
    `,
    [telegramUserId, limit]
  );

  return result.rows;
};

export const listRecentLogs = async (limit = 50): Promise<MessageLogRecord[]> => {
  await withSchema();
  const result = await pool.query<MessageLogRecord>(
    `
      SELECT *
      FROM message_logs
      ORDER BY created_at DESC, id DESC
      LIMIT $1
    `,
    [limit]
  );

  return result.rows;
};

export const recordTokenUsage = async (
  input: TokenUsageLedgerInput
): Promise<{ applied: boolean; totals: UserUsageTotalsRecord }> => {
  await withSchema();

  const normalized: TokenUsageLedgerInput = {
    telegram_user_id: input.telegram_user_id,
    session_key: input.session_key.trim(),
    run_id: input.run_id.trim(),
    idempotency_key: input.idempotency_key.trim(),
    provider: input.provider?.trim() || null,
    model: input.model?.trim() || null,
    input_tokens: normalizeTokenValue(input.input_tokens),
    output_tokens: normalizeTokenValue(input.output_tokens),
    cache_read_tokens: normalizeTokenValue(input.cache_read_tokens),
    cache_write_tokens: normalizeTokenValue(input.cache_write_tokens),
    total_tokens: normalizeTokenValue(input.total_tokens),
    cost_usd: normalizeCostValue(input.cost_usd)
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const inserted = await client.query<{ id: number }>(
      `
        INSERT INTO token_usage_ledger (
          telegram_user_id,
          session_key,
          run_id,
          idempotency_key,
          provider,
          model,
          input_tokens,
          output_tokens,
          cache_read_tokens,
          cache_write_tokens,
          total_tokens,
          cost_usd
        ) VALUES (
          $1, $2, $3, $4,
          $5, $6, $7, $8,
          $9, $10, $11, $12
        )
        ON CONFLICT (telegram_user_id, idempotency_key)
        DO NOTHING
        RETURNING id
      `,
      [
        normalized.telegram_user_id,
        normalized.session_key,
        normalized.run_id,
        normalized.idempotency_key,
        normalized.provider,
        normalized.model,
        normalized.input_tokens,
        normalized.output_tokens,
        normalized.cache_read_tokens,
        normalized.cache_write_tokens,
        normalized.total_tokens,
        normalized.cost_usd
      ]
    );

    const applied = (inserted.rowCount ?? 0) > 0;
    if (applied) {
      await client.query(
        `
          INSERT INTO user_usage_totals (
            telegram_user_id,
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_write_tokens,
            total_tokens,
            total_cost_usd,
            updated_at
          ) VALUES (
            $1, $2, $3, $4,
            $5, $6, $7, $8::timestamptz
          )
          ON CONFLICT (telegram_user_id) DO UPDATE SET
            input_tokens = user_usage_totals.input_tokens + EXCLUDED.input_tokens,
            output_tokens = user_usage_totals.output_tokens + EXCLUDED.output_tokens,
            cache_read_tokens = user_usage_totals.cache_read_tokens + EXCLUDED.cache_read_tokens,
            cache_write_tokens = user_usage_totals.cache_write_tokens + EXCLUDED.cache_write_tokens,
            total_tokens = user_usage_totals.total_tokens + EXCLUDED.total_tokens,
            total_cost_usd = user_usage_totals.total_cost_usd + EXCLUDED.total_cost_usd,
            updated_at = EXCLUDED.updated_at
        `,
        [
          normalized.telegram_user_id,
          normalized.input_tokens,
          normalized.output_tokens,
          normalized.cache_read_tokens,
          normalized.cache_write_tokens,
          normalized.total_tokens,
          normalized.cost_usd,
          nowIso()
        ]
      );
    }

    const totalsResult = await client.query<UserUsageTotalsRecord>(
      `
        SELECT *
        FROM user_usage_totals
        WHERE telegram_user_id = $1
      `,
      [normalized.telegram_user_id]
    );

    await client.query('COMMIT');

    return {
      applied,
      totals: totalsResult.rows[0] ?? emptyUsageTotals(normalized.telegram_user_id)
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

export const getUserUsageTotals = async (telegramUserId: number): Promise<UserUsageTotalsRecord> => {
  await withSchema();
  const result = await pool.query<UserUsageTotalsRecord>(
    `
      SELECT *
      FROM user_usage_totals
      WHERE telegram_user_id = $1
    `,
    [telegramUserId]
  );

  return result.rows[0] ?? emptyUsageTotals(telegramUserId);
};

export const listUsersWithUsage = async (): Promise<UserWithUsageRecord[]> => {
  await withSchema();
  const result = await pool.query<UserWithUsageRecord>(
    `
      SELECT
        users.*,
        COALESCE(user_usage_totals.input_tokens, 0) AS input_tokens,
        COALESCE(user_usage_totals.output_tokens, 0) AS output_tokens,
        COALESCE(user_usage_totals.cache_read_tokens, 0) AS cache_read_tokens,
        COALESCE(user_usage_totals.cache_write_tokens, 0) AS cache_write_tokens,
        COALESCE(user_usage_totals.total_tokens, 0) AS total_tokens,
        COALESCE(user_usage_totals.total_cost_usd, 0) AS total_cost_usd
      FROM users
      LEFT JOIN user_usage_totals
        ON user_usage_totals.telegram_user_id = users.telegram_user_id
      ORDER BY users.created_at DESC, users.id DESC
    `
  );

  return result.rows;
};

export const listTokenUsageLedgerByUser = async (
  telegramUserId: number,
  limit = 100
): Promise<TokenUsageLedgerRecord[]> => {
  await withSchema();
  const result = await pool.query<TokenUsageLedgerRecord>(
    `
      SELECT *
      FROM token_usage_ledger
      WHERE telegram_user_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2
    `,
    [telegramUserId, limit]
  );

  return result.rows;
};

export const getUsageOverview = async (): Promise<UsageOverviewRecord> => {
  await withSchema();
  const result = await pool.query<UsageOverviewRecord>(
    `
      SELECT
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(total_cost_usd), 0) AS total_cost_usd
      FROM user_usage_totals
    `
  );

  return (
    result.rows[0] ?? {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      total_tokens: 0,
      total_cost_usd: 0
    }
  );
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
              WHEN litellm_budget_usd IS NOT NULL
               AND litellm_budget_usd > 0
               AND COALESCE(litellm_spend_usd, 0) >= litellm_budget_usd
              THEN 1
              ELSE 0
            END
          ),
          0
        )::int AS assistants_over_budget,
        COALESCE(SUM(COALESCE(litellm_spend_usd, 0)), 0) AS total_spend_usd
      FROM assistants
      WHERE litellm_virtual_key_encrypted IS NOT NULL
        AND litellm_virtual_key_encrypted != ''
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
