import { pool, randomToken } from '../common/db/core.js';

export type GoogleCredentialRow = {
  user_id: number;
  telegram_user_id: number;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  id_token_enc: string | null;
  token_type: string | null;
  scope: string | null;
  expiry_at: string | null;
  raw_payload: Record<string, unknown>;
  updated_at: string;
};

export const extractGoogleConnectedEmail = (row: GoogleCredentialRow | null): string | null => {
  const email = row?.raw_payload && typeof row.raw_payload.email === 'string' ? row.raw_payload.email.trim() : '';
  return email || null;
};

export const createOAuthState = async (params: {
  telegramUserId: number;
  nextPath: string;
  codeVerifier?: string | null;
  ttlSec?: number;
}): Promise<string> => {
  const token = randomToken(24);
  const ttlSec = params.ttlSec ?? 600;
  await pool.query(
    `INSERT INTO google_oauth_states (state_token, telegram_user_id, next_path, code_verifier, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + ($5 || ' seconds')::interval)`,
    [token, params.telegramUserId, params.nextPath, params.codeVerifier ?? null, String(ttlSec)],
  );
  return token;
};

export const consumeOAuthState = async (stateToken: string): Promise<{
  telegramUserId: number;
  nextPath: string;
  codeVerifier: string | null;
} | null> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<{
      telegram_user_id: number;
      next_path: string;
      code_verifier: string | null;
      expires_at: string;
    }>(
      `SELECT telegram_user_id, next_path, code_verifier, expires_at
       FROM google_oauth_states
       WHERE state_token = $1
       FOR UPDATE`,
      [stateToken],
    );
    const row = result.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return null;
    }

    await client.query(`DELETE FROM google_oauth_states WHERE state_token = $1`, [stateToken]);
    await client.query('COMMIT');

    if (Date.parse(row.expires_at) < Date.now()) return null;

    return {
      telegramUserId: row.telegram_user_id,
      nextPath: row.next_path,
      codeVerifier: row.code_verifier,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

export const findUserIdentityByTelegramId = async (telegramUserId: number): Promise<{
  id: number;
  telegram_username: string | null;
} | null> => {
  const result = await pool.query<{ id: number; telegram_username: string | null }>(
    `SELECT id, telegram_username FROM users WHERE telegram_user_id = $1 LIMIT 1`,
    [telegramUserId],
  );
  return result.rows[0] || null;
};

export const saveGoogleCredential = async (params: {
  userId: number;
  telegramUserId: number;
  accessTokenEnc: string | null;
  refreshTokenEnc: string | null;
  idTokenEnc: string | null;
  tokenType: string | null;
  scope: string | null;
  expiryAt: string | null;
  rawPayload: Record<string, unknown>;
}): Promise<void> => {
  await pool.query(
    `INSERT INTO google_oauth_credentials (
      user_id,
      telegram_user_id,
      access_token_enc,
      refresh_token_enc,
      id_token_enc,
      token_type,
      scope,
      expiry_at,
      raw_payload,
      updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::jsonb, NOW()
    )
    ON CONFLICT (user_id)
    DO UPDATE SET
      telegram_user_id = EXCLUDED.telegram_user_id,
      access_token_enc = EXCLUDED.access_token_enc,
      refresh_token_enc = COALESCE(EXCLUDED.refresh_token_enc, google_oauth_credentials.refresh_token_enc),
      id_token_enc = EXCLUDED.id_token_enc,
      token_type = EXCLUDED.token_type,
      scope = EXCLUDED.scope,
      expiry_at = EXCLUDED.expiry_at,
      raw_payload = EXCLUDED.raw_payload,
      updated_at = NOW()`,
    [
      params.userId,
      params.telegramUserId,
      params.accessTokenEnc,
      params.refreshTokenEnc,
      params.idTokenEnc,
      params.tokenType,
      params.scope,
      params.expiryAt,
      JSON.stringify(params.rawPayload || {}),
    ],
  );
};

export const getGoogleCredentialByTelegramId = async (
  telegramUserId: number,
): Promise<GoogleCredentialRow | null> => {
  const result = await pool.query<GoogleCredentialRow>(
    `SELECT
      user_id,
      telegram_user_id,
      access_token_enc,
      refresh_token_enc,
      id_token_enc,
      token_type,
      scope,
      expiry_at,
      raw_payload,
      updated_at
     FROM google_oauth_credentials
     WHERE telegram_user_id = $1
     LIMIT 1`,
    [telegramUserId],
  );
  return result.rows[0] || null;
};

export const deleteGoogleCredentialByTelegramId = async (telegramUserId: number): Promise<void> => {
  await pool.query(`DELETE FROM google_oauth_credentials WHERE telegram_user_id = $1`, [telegramUserId]);
};

export const findLatestAssistantRuntimeByTelegramId = async (telegramUserId: number): Promise<{
  runtime_provider: string | null;
  runtime_ref: string | null;
  host_port: number | null;
} | null> => {
  const result = await pool.query<{
    runtime_provider: string | null;
    runtime_ref: string | null;
    host_port: number | null;
  }>(
    `SELECT r.runtime_provider, r.runtime_ref, r.host_port
     FROM users u
     LEFT JOIN assistants a ON a.owner_user_id = u.id
     LEFT JOIN runtime_instances r
       ON r.assistant_id = a.id
      AND r.scope = 'assistant'
     WHERE u.telegram_user_id = $1
     ORDER BY
       CASE WHEN r.status = 'running' THEN 0 ELSE 1 END,
       r.updated_at DESC NULLS LAST,
       a.id DESC
     LIMIT 1`,
    [telegramUserId],
  );
  return result.rows[0] || null;
};
