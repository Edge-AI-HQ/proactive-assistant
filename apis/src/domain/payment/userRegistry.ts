import crypto from 'crypto';

type Queryable = {
  query: <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ) => Promise<{ rows: T[]; rowCount: number | null }>;
};

const firstRow = <T>(rows: T[]): T | null => rows[0] ?? null;

export interface ResolvedUser {
  id: number;
  supabase_user_id: string;
  display_name: string | null;
}

export const parseSupabaseUserId = (value: string): number => {
  const trimmed = String(value || '').trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error('supabase_user_id must be a positive integer string');
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error('supabase_user_id is out of supported range');
  }

  return parsed;
};

export const normalizeUsername = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const buildContainerProxySecret = (): string => crypto.randomBytes(24).toString('hex');

export const resolveOrCreateUser = async (
  pool: Queryable,
  supabase_user_id: string,
  display_name?: string | null
): Promise<ResolvedUser> => {
  const parsedSupabaseId = parseSupabaseUserId(supabase_user_id);
  const username = normalizeUsername(display_name);

  const result = await pool.query<{ id: number; supabase_user_id: number; display_name: string | null }>(
    `
      INSERT INTO users (
        supabase_user_id,
        display_name,
        container_proxy_secret,
        updated_at,
        last_active_at
      ) VALUES (
        $1,
        $2,
        $3,
        NOW(),
        NOW()
      )
      ON CONFLICT (supabase_user_id)
      DO UPDATE SET
        display_name = COALESCE(EXCLUDED.display_name, users.display_name),
        updated_at = NOW(),
        last_active_at = NOW()
      RETURNING id, supabase_user_id, display_name
    `,
    [parsedSupabaseId, username, buildContainerProxySecret()]
  );

  const user = firstRow(result.rows);
  if (!user) {
    throw new Error(`Failed to upsert user ${supabase_user_id}`);
  }

  return {
    id: user.id,
    supabase_user_id: String(user.supabase_user_id),
    display_name: user.display_name
  };
};

export const lookupUserBySupabaseId = async (
  pool: Queryable,
  supabase_user_id: string
): Promise<ResolvedUser | null> => {
  const parsedSupabaseId = parseSupabaseUserId(supabase_user_id);

  const result = await pool.query<{ id: number; supabase_user_id: number; display_name: string | null }>(
    `
      SELECT id, supabase_user_id, display_name
      FROM users
      WHERE supabase_user_id = $1
      LIMIT 1
    `,
    [parsedSupabaseId]
  );

  const row = firstRow(result.rows);
  if (!row) return null;

  return {
    id: row.id,
    supabase_user_id: String(row.supabase_user_id),
    display_name: row.display_name
  };
};
