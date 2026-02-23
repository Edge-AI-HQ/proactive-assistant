import type { CreateUserInput, UserMutableFields, UserRecord } from '../../../types.js';
import {
  buildAssignments,
  fetchOne,
  nowIso,
  pool,
  userFromClause,
  userSelectColumns,
  withSchema,
  randomToken,
  resolveUserByLiteLLMUserId
} from './core.js';

const userDataColumns = [
  'telegram_username',
  'litellm_user_id',
  'litellm_user_alias',
  'litellm_key_alias',
  'litellm_virtual_key_encrypted',
  'litellm_key_last4',
  'litellm_spend_usd',
  'litellm_budget_usd',
  'litellm_budget_duration',
  'litellm_rpm_limit',
  'litellm_tpm_limit',
  'litellm_last_synced_at',
  'gateway_token'
] as const;

export const createGatewayToken = (): string => randomToken(24);

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

export const getUserByLiteLLMUserId = async (litellmUserId: string): Promise<UserRecord | undefined> => {
  await withSchema();
  const identity = await resolveUserByLiteLLMUserId(pool, litellmUserId);
  if (!identity) return undefined;
  return getUserById(identity.id);
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
          litellm_key_alias,
          litellm_virtual_key_encrypted,
          litellm_key_last4,
          litellm_spend_usd,
          litellm_budget_usd,
          litellm_budget_duration,
          litellm_rpm_limit,
          litellm_tpm_limit,
          litellm_last_synced_at,
          gateway_token,
          last_active_at,
          updated_at
        ) VALUES (
          $1, $2, $3, $4,
          $5, $6, $7, $8,
          $9, $10, $11, $12,
          $13, $14, $15::timestamptz, $16::timestamptz
        )
        RETURNING id
      `,
      [
        user.telegram_user_id,
        user.telegram_username ?? null,
        user.litellm_user_id ?? null,
        user.litellm_user_alias ?? null,
        user.litellm_key_alias ?? null,
        user.litellm_virtual_key_encrypted ?? null,
        user.litellm_key_last4 ?? null,
        user.litellm_spend_usd ?? 0,
        user.litellm_budget_usd ?? null,
        user.litellm_budget_duration ?? null,
        user.litellm_rpm_limit ?? null,
        user.litellm_tpm_limit ?? null,
        user.litellm_last_synced_at ?? null,
        user.gateway_token,
        nowIso(),
        nowIso()
      ]
    );

    const userId = createdUser.rows[0]?.id;
    if (!userId) {
      throw new Error(`Failed to create user ${user.telegram_user_id}`);
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return getUserByTelegramId(user.telegram_user_id);
};

export const updateUser = async (telegramUserId: number, fields: UserMutableFields): Promise<UserRecord | undefined> => {
  await withSchema();

  const dataAssignments = buildAssignments(fields, userDataColumns);

  if (!dataAssignments.sql) {
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
  await pool.query(
    'UPDATE users SET last_active_at = $1::timestamptz, updated_at = $2::timestamptz WHERE telegram_user_id = $3',
    [nowIso(), nowIso(), telegramUserId]
  );
  return getUserByTelegramId(telegramUserId);
};

export const updateUserById = async (id: number, fields: UserMutableFields): Promise<UserRecord | undefined> => {
  await withSchema();

  const existing = await getUserById(id);
  if (!existing) return undefined;

  return updateUser(existing.telegram_user_id, fields);
};

export const deleteUserByTelegramId = async (telegramUserId: number): Promise<UserRecord | undefined> => {
  await withSchema();

  const existing = await getUserByTelegramId(telegramUserId);
  if (!existing) return undefined;

  await pool.query('DELETE FROM users WHERE telegram_user_id = $1', [telegramUserId]);
  return existing;
};
