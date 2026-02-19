import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { config } from './config.js';
import type {
  AssistantMutableFields,
  AssistantRecord,
  AdminSessionView,
  AdminUserRecord,
  CreateAssistantInput,
  CreateUserInput,
  GatewaySessionRecord,
  MessageLogRecord,
  TokenUsageLedgerInput,
  TokenUsageLedgerRecord,
  UsageOverviewRecord,
  UserMutableFields,
  UserRecord,
  UserUsageTotalsRecord,
  UserWithUsageRecord
} from './types.js';

const ensureDir = (filePath: string): void => {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

ensureDir(config.databasePath);

const db = new Database(config.databasePath);

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_user_id BIGINT UNIQUE NOT NULL,
    telegram_username TEXT,
    container_id TEXT UNIQUE NOT NULL,
    container_port INTEGER UNIQUE NOT NULL,
    container_status TEXT DEFAULT 'creating',
    gateway_token TEXT UNIQUE NOT NULL,
    assistant_bot_token TEXT,
    assistant_bot_username TEXT,
    assistant_webhook_secret TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_active_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS assistants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_telegram_user_id BIGINT NOT NULL,
    assistant_bot_id BIGINT UNIQUE NOT NULL,
    assistant_bot_token TEXT UNIQUE NOT NULL,
    assistant_bot_username TEXT UNIQUE NOT NULL,
    container_name TEXT UNIQUE NOT NULL,
    container_id TEXT UNIQUE NOT NULL,
    container_port INTEGER UNIQUE NOT NULL,
    container_status TEXT DEFAULT 'creating',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS gateway_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_user_id BIGINT NOT NULL,
    session_token TEXT UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL
  );

  CREATE TABLE IF NOT EXISTS message_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_user_id BIGINT NOT NULL,
    direction TEXT,
    message_text TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    email TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS admin_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id INTEGER NOT NULL,
    session_token TEXT UNIQUE NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    FOREIGN KEY (admin_id) REFERENCES admin_users(id)
  );

  CREATE TABLE IF NOT EXISTS token_usage_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_user_id BIGINT NOT NULL,
    session_key TEXT NOT NULL,
    run_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    provider TEXT,
    model TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (telegram_user_id, idempotency_key)
  );

  CREATE TABLE IF NOT EXISTS user_usage_totals (
    telegram_user_id BIGINT PRIMARY KEY,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    total_cost_usd REAL NOT NULL DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_gateway_sessions_expires_at
    ON gateway_sessions (expires_at);

  CREATE INDEX IF NOT EXISTS idx_gateway_sessions_user_created
    ON gateway_sessions (telegram_user_id, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_message_logs_user_created
    ON message_logs (telegram_user_id, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_assistants_owner_created
    ON assistants (owner_telegram_user_id, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_token_usage_ledger_user_created
    ON token_usage_ledger (telegram_user_id, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_token_usage_ledger_run_id
    ON token_usage_ledger (run_id);

  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_assistant_bot_token_unique
    ON users (assistant_bot_token)
    WHERE assistant_bot_token IS NOT NULL AND assistant_bot_token != '';

  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_assistant_bot_username_unique
    ON users (assistant_bot_username)
    WHERE assistant_bot_username IS NOT NULL AND assistant_bot_username != '';
`);

interface TableColumnInfo {
  name: string;
}

const safeIdentifier = (value: string): string => {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe SQL identifier: ${value}`);
  }
  return value;
};

const hasTable = (name: string): boolean => {
  return Boolean(
    db
      .prepare<[string], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name)
  );
};

const listTableColumns = (tableName: string): string[] => {
  const safe = safeIdentifier(tableName);
  return db
    .prepare<[], TableColumnInfo>(`PRAGMA table_info(${safe})`)
    .all()
    .map((row) => row.name);
};

const migrateUsersToTelegramSchema = (): void => {
  if (!hasTable('users')) return;

  const columns = new Set(listTableColumns('users'));
  const hasLegacyGoogleColumns = columns.has('google_email') || columns.has('google_id');
  if (!hasLegacyGoogleColumns) return;

  const runMigration = db.transaction(() => {
    db.exec(`
      DROP TABLE IF EXISTS users_migrated;

      CREATE TABLE users_migrated (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_user_id BIGINT UNIQUE NOT NULL,
        telegram_username TEXT,
        container_id TEXT UNIQUE NOT NULL,
        container_port INTEGER UNIQUE NOT NULL,
        container_status TEXT DEFAULT 'creating',
        gateway_token TEXT UNIQUE NOT NULL,
        assistant_bot_token TEXT,
        assistant_bot_username TEXT,
        assistant_webhook_secret TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_active_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      INSERT INTO users_migrated (
        id,
        telegram_user_id,
        telegram_username,
        container_id,
        container_port,
        container_status,
        gateway_token,
        assistant_bot_token,
        assistant_bot_username,
        assistant_webhook_secret,
        created_at,
        last_active_at
      )
      SELECT
        id,
        telegram_user_id,
        telegram_username,
        container_id,
        container_port,
        container_status,
        gateway_token,
        NULL,
        NULL,
        NULL,
        created_at,
        last_active_at
      FROM users;

      DROP TABLE users;
      ALTER TABLE users_migrated RENAME TO users;
    `);
  });

  runMigration();
  console.info('[db] Migrated users table to Telegram-only schema.');
};

const ensureUsersAssistantBotColumns = (): void => {
  if (!hasTable('users')) return;

  const columns = new Set(listTableColumns('users'));
  const migrationStatements: string[] = [];

  if (!columns.has('assistant_bot_token')) {
    migrationStatements.push('ALTER TABLE users ADD COLUMN assistant_bot_token TEXT');
  }
  if (!columns.has('assistant_bot_username')) {
    migrationStatements.push('ALTER TABLE users ADD COLUMN assistant_bot_username TEXT');
  }
  if (!columns.has('assistant_webhook_secret')) {
    migrationStatements.push('ALTER TABLE users ADD COLUMN assistant_webhook_secret TEXT');
  }

  if (migrationStatements.length) {
    const runMigration = db.transaction(() => {
      migrationStatements.forEach((statement) => db.exec(statement));
    });
    runMigration();
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_assistant_bot_token_unique
      ON users (assistant_bot_token)
      WHERE assistant_bot_token IS NOT NULL AND assistant_bot_token != '';

    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_assistant_bot_username_unique
      ON users (assistant_bot_username)
      WHERE assistant_bot_username IS NOT NULL AND assistant_bot_username != '';
  `);
};

const migrateLegacyUserAssistants = (): void => {
  if (!hasTable('users') || !hasTable('assistants')) return;

  db.exec(`
    INSERT OR IGNORE INTO assistants (
      owner_telegram_user_id,
      assistant_bot_id,
      assistant_bot_token,
      assistant_bot_username,
      container_name,
      container_id,
      container_port,
      container_status,
      created_at,
      updated_at
    )
    SELECT
      users.telegram_user_id AS owner_telegram_user_id,
      CAST(substr(users.assistant_bot_token, 1, instr(users.assistant_bot_token, ':') - 1) AS INTEGER) AS assistant_bot_id,
      users.assistant_bot_token,
      COALESCE(NULLIF(users.assistant_bot_username, ''), 'legacy_bot_' || users.telegram_user_id) AS assistant_bot_username,
      COALESCE(NULLIF(users.container_id, ''), 'openclaw-assistant-' || users.telegram_user_id) AS container_name,
      users.container_id,
      users.container_port,
      COALESCE(NULLIF(users.container_status, ''), 'creating') AS container_status,
      COALESCE(users.created_at, CURRENT_TIMESTAMP) AS created_at,
      COALESCE(users.last_active_at, CURRENT_TIMESTAMP) AS updated_at
    FROM users
    WHERE
      users.assistant_bot_token IS NOT NULL
      AND users.assistant_bot_token != ''
      AND instr(users.assistant_bot_token, ':') > 1
      AND users.container_port IS NOT NULL
      AND users.container_id IS NOT NULL
      AND users.container_id != '';
  `);
};

const cleanupLegacyAuthTables = (): void => {
  db.exec(`
    DROP TABLE IF EXISTS oauth_sessions;
    DROP TABLE IF EXISTS gateway_oauth_sessions;
    DROP TABLE IF EXISTS auth_allowlist;
  `);
};

migrateUsersToTelegramSchema();
ensureUsersAssistantBotColumns();
migrateLegacyUserAssistants();
cleanupLegacyAuthTables();

const nowIso = (): string => new Date().toISOString();

const randomToken = (size = 24): string => crypto.randomBytes(size).toString('hex');

export const createGatewaySession = (
  telegramUserId: number,
  ttlHours: number
): { sessionToken: string; expiresAt: string } => {
  const sessionToken = randomToken(32);
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString();
  db.prepare<[number, string, string]>(`
    INSERT INTO gateway_sessions (telegram_user_id, session_token, expires_at)
    VALUES (?, ?, ?)
  `).run(telegramUserId, sessionToken, expiresAt);
  return { sessionToken, expiresAt };
};

export const getGatewaySession = (sessionToken: string): GatewaySessionRecord | undefined => {
  return db.prepare<[string, string], GatewaySessionRecord>(`
    SELECT * FROM gateway_sessions WHERE session_token = ? AND expires_at > ?
  `).get(sessionToken, nowIso());
};

export const cleanupExpiredGatewaySessions = (): void => {
  db.prepare<[string]>('DELETE FROM gateway_sessions WHERE expires_at <= ?').run(nowIso());
};

export const getUserByTelegramId = (telegramUserId: number): UserRecord | undefined => {
  return db.prepare<[number], UserRecord>('SELECT * FROM users WHERE telegram_user_id = ?').get(telegramUserId);
};

export const getUserById = (id: number): UserRecord | undefined => {
  return db.prepare<[number], UserRecord>('SELECT * FROM users WHERE id = ?').get(id);
};

export const getAssistantById = (id: number): AssistantRecord | undefined => {
  return db.prepare<[number], AssistantRecord>('SELECT * FROM assistants WHERE id = ?').get(id);
};

export const getAssistantByBotToken = (assistantBotToken: string): AssistantRecord | undefined => {
  return db
    .prepare<[string], AssistantRecord>('SELECT * FROM assistants WHERE assistant_bot_token = ?')
    .get(assistantBotToken);
};

export const getAssistantByBotId = (assistantBotId: number): AssistantRecord | undefined => {
  return db
    .prepare<[number], AssistantRecord>('SELECT * FROM assistants WHERE assistant_bot_id = ?')
    .get(assistantBotId);
};

export const listAssistantsByOwnerTelegramId = (ownerTelegramUserId: number): AssistantRecord[] => {
  return db
    .prepare<[number], AssistantRecord>(`
      SELECT *
      FROM assistants
      WHERE owner_telegram_user_id = ?
      ORDER BY created_at DESC, id DESC
    `)
    .all(ownerTelegramUserId);
};

export const createAssistant = (assistant: CreateAssistantInput): AssistantRecord | undefined => {
  db.prepare<
    [number, number, string, string, string, string, number, string, string]
  >(`
    INSERT INTO assistants (
      owner_telegram_user_id,
      assistant_bot_id,
      assistant_bot_token,
      assistant_bot_username,
      container_name,
      container_id,
      container_port,
      container_status,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    assistant.owner_telegram_user_id,
    assistant.assistant_bot_id,
    assistant.assistant_bot_token,
    assistant.assistant_bot_username,
    assistant.container_name,
    assistant.container_id,
    assistant.container_port,
    assistant.container_status || 'creating',
    nowIso()
  );

  return getAssistantByBotId(assistant.assistant_bot_id);
};

const assistantColumnsAndValues = (
  fields: AssistantMutableFields
): { columns: (keyof AssistantMutableFields)[]; values: unknown[] } => {
  const columns = Object.keys(fields) as (keyof AssistantMutableFields)[];
  return {
    columns,
    values: columns.map((column) => fields[column])
  };
};

export const updateAssistant = (id: number, fields: AssistantMutableFields): AssistantRecord | undefined => {
  const { columns, values } = assistantColumnsAndValues(fields);
  if (!columns.length) return getAssistantById(id);
  const assignments = columns.map((column) => `${String(column)} = ?`).join(', ');
  db.prepare(`UPDATE assistants SET ${assignments}, updated_at = ? WHERE id = ?`).run(...values, nowIso(), id);
  return getAssistantById(id);
};

export const getUserByAssistantBotToken = (assistantBotToken: string): UserRecord | undefined => {
  return db.prepare<[string], UserRecord>('SELECT * FROM users WHERE assistant_bot_token = ?').get(assistantBotToken);
};

export const getUserByAssistantBotUsername = (assistantBotUsername: string): UserRecord | undefined => {
  return db
    .prepare<[string], UserRecord>('SELECT * FROM users WHERE assistant_bot_username = ?')
    .get(assistantBotUsername);
};

export const listUsers = (): UserRecord[] => {
  return db.prepare<[], UserRecord>('SELECT * FROM users ORDER BY created_at DESC').all();
};

export const createUser = (user: CreateUserInput): UserRecord | undefined => {
  const stmt = db.prepare<
    [number, string | null, string, number, string, string, string | null, string | null, string | null, string]
  >(`
    INSERT INTO users (
      telegram_user_id,
      telegram_username,
      container_id,
      container_port,
      container_status,
      gateway_token,
      assistant_bot_token,
      assistant_bot_username,
      assistant_webhook_secret,
      last_active_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    user.telegram_user_id,
    user.telegram_username || null,
    user.container_id,
    user.container_port,
    user.container_status || 'creating',
    user.gateway_token,
    user.assistant_bot_token || null,
    user.assistant_bot_username || null,
    user.assistant_webhook_secret || null,
    nowIso()
  );
  return getUserByTelegramId(user.telegram_user_id);
};

const columnsAndValues = (fields: UserMutableFields): { columns: (keyof UserMutableFields)[]; values: unknown[] } => {
  const columns = Object.keys(fields) as (keyof UserMutableFields)[];
  return {
    columns,
    values: columns.map((column) => fields[column])
  };
};

export const updateUser = (telegramUserId: number, fields: UserMutableFields): UserRecord | undefined => {
  const { columns, values } = columnsAndValues(fields);
  if (!columns.length) return getUserByTelegramId(telegramUserId);
  const assignments = columns.map((col) => `${String(col)} = ?`).join(', ');
  db.prepare(`UPDATE users SET ${assignments}, last_active_at = ? WHERE telegram_user_id = ?`).run(
    ...values,
    nowIso(),
    telegramUserId
  );
  return getUserByTelegramId(telegramUserId);
};

export const touchUser = (telegramUserId: number): UserRecord | undefined => {
  db.prepare<[string, number]>('UPDATE users SET last_active_at = ? WHERE telegram_user_id = ?').run(
    nowIso(),
    telegramUserId
  );
  return getUserByTelegramId(telegramUserId);
};

export const updateUserById = (id: number, fields: UserMutableFields): UserRecord | undefined => {
  const { columns, values } = columnsAndValues(fields);
  if (!columns.length) return getUserById(id);
  const assignments = columns.map((col) => `${String(col)} = ?`).join(', ');
  db.prepare(`UPDATE users SET ${assignments} WHERE id = ?`).run(...values, id);
  return getUserById(id);
};

export const listUsedPorts = (): number[] => {
  return db
    .prepare<[], { container_port: number }>(`
      SELECT container_port
      FROM users
      WHERE container_port > 0
        AND COALESCE(container_status, '') != 'idle'
      UNION
      SELECT container_port
      FROM assistants
      WHERE container_port > 0
    `)
    .all()
    .map((row) => row.container_port);
};

export const logMessage = (telegramUserId: number, direction: string, messageText: string): void => {
  db.prepare<[number, string, string]>(`
    INSERT INTO message_logs (telegram_user_id, direction, message_text)
    VALUES (?, ?, ?)
  `).run(telegramUserId, direction, messageText);
};

export const listMessageLogs = (telegramUserId: number, limit = 20): MessageLogRecord[] => {
  return db.prepare<[number, number], MessageLogRecord>(`
    SELECT * FROM message_logs WHERE telegram_user_id = ? ORDER BY created_at DESC LIMIT ?
  `).all(telegramUserId, limit);
};

export const listRecentLogs = (limit = 50): MessageLogRecord[] => {
  return db.prepare<[number], MessageLogRecord>(`
    SELECT * FROM message_logs ORDER BY created_at DESC LIMIT ?
  `).all(limit);
};

const normalizeTokenValue = (value: number): number => {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
};

const normalizeCostValue = (value: number): number => {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
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

const getUserUsageTotalsStmt = db.prepare<[number], UserUsageTotalsRecord>(`
  SELECT *
  FROM user_usage_totals
  WHERE telegram_user_id = ?
`);

const insertTokenUsageLedgerStmt = db.prepare<
  [
    number,
    string,
    string,
    string,
    string | null,
    string | null,
    number,
    number,
    number,
    number,
    number,
    number
  ]
>(`
  INSERT OR IGNORE INTO token_usage_ledger (
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
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const upsertUserUsageTotalsStmt = db.prepare<
  [number, number, number, number, number, number, number, string]
>(`
  INSERT INTO user_usage_totals (
    telegram_user_id,
    input_tokens,
    output_tokens,
    cache_read_tokens,
    cache_write_tokens,
    total_tokens,
    total_cost_usd,
    updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(telegram_user_id) DO UPDATE SET
    input_tokens = user_usage_totals.input_tokens + excluded.input_tokens,
    output_tokens = user_usage_totals.output_tokens + excluded.output_tokens,
    cache_read_tokens = user_usage_totals.cache_read_tokens + excluded.cache_read_tokens,
    cache_write_tokens = user_usage_totals.cache_write_tokens + excluded.cache_write_tokens,
    total_tokens = user_usage_totals.total_tokens + excluded.total_tokens,
    total_cost_usd = user_usage_totals.total_cost_usd + excluded.total_cost_usd,
    updated_at = excluded.updated_at
`);

const persistTokenUsageTx = db.transaction(
  (usage: TokenUsageLedgerInput): { applied: boolean; totals: UserUsageTotalsRecord } => {
    const insertResult = insertTokenUsageLedgerStmt.run(
      usage.telegram_user_id,
      usage.session_key,
      usage.run_id,
      usage.idempotency_key,
      usage.provider ?? null,
      usage.model ?? null,
      usage.input_tokens,
      usage.output_tokens,
      usage.cache_read_tokens,
      usage.cache_write_tokens,
      usage.total_tokens,
      usage.cost_usd
    );

    if (insertResult.changes === 0) {
      return {
        applied: false,
        totals: getUserUsageTotalsStmt.get(usage.telegram_user_id) ?? emptyUsageTotals(usage.telegram_user_id)
      };
    }

    const updatedAt = nowIso();
    upsertUserUsageTotalsStmt.run(
      usage.telegram_user_id,
      usage.input_tokens,
      usage.output_tokens,
      usage.cache_read_tokens,
      usage.cache_write_tokens,
      usage.total_tokens,
      usage.cost_usd,
      updatedAt
    );

    return {
      applied: true,
      totals: getUserUsageTotalsStmt.get(usage.telegram_user_id) ?? {
        ...emptyUsageTotals(usage.telegram_user_id),
        updated_at: updatedAt
      }
    };
  }
);

export const recordTokenUsage = (
  input: TokenUsageLedgerInput
): { applied: boolean; totals: UserUsageTotalsRecord } => {
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

  return persistTokenUsageTx(normalized);
};

export const getUserUsageTotals = (telegramUserId: number): UserUsageTotalsRecord => {
  return getUserUsageTotalsStmt.get(telegramUserId) ?? emptyUsageTotals(telegramUserId);
};

export const listUsersWithUsage = (): UserWithUsageRecord[] => {
  return db.prepare<[], UserWithUsageRecord>(`
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
    ORDER BY users.created_at DESC
  `).all();
};

export const listTokenUsageLedgerByUser = (telegramUserId: number, limit = 100): TokenUsageLedgerRecord[] => {
  return db.prepare<[number, number], TokenUsageLedgerRecord>(`
    SELECT *
    FROM token_usage_ledger
    WHERE telegram_user_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(telegramUserId, limit);
};

export const getUsageOverview = (): UsageOverviewRecord => {
  const row = db.prepare<[], Omit<UsageOverviewRecord, 'total_cost_usd'> & { total_cost_usd: number }>(`
    SELECT
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
      COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
      COALESCE(SUM(total_tokens), 0) AS total_tokens,
      COALESCE(SUM(total_cost_usd), 0) AS total_cost_usd
    FROM user_usage_totals
  `).get();

  return {
    input_tokens: row?.input_tokens ?? 0,
    output_tokens: row?.output_tokens ?? 0,
    cache_read_tokens: row?.cache_read_tokens ?? 0,
    cache_write_tokens: row?.cache_write_tokens ?? 0,
    total_tokens: row?.total_tokens ?? 0,
    total_cost_usd: row?.total_cost_usd ?? 0
  };
};

export const ensureAdminUser = (
  username: string,
  passwordHash: string
): AdminUserRecord | null | undefined => {
  if (!passwordHash) return null;
  const existing = db
    .prepare<[string], AdminUserRecord>('SELECT * FROM admin_users WHERE username = ?')
    .get(username);
  if (existing) return existing;
  db.prepare<[string, string]>(`
    INSERT INTO admin_users (username, password_hash)
    VALUES (?, ?)
  `).run(username, passwordHash);
  return db.prepare<[string], AdminUserRecord>('SELECT * FROM admin_users WHERE username = ?').get(username);
};

export const getAdminByUsername = (username: string): AdminUserRecord | undefined => {
  return db.prepare<[string], AdminUserRecord>('SELECT * FROM admin_users WHERE username = ?').get(username);
};

export const createAdminSession = (
  adminId: number,
  ttlHours: number
): { sessionToken: string; expiresAt: string } => {
  const sessionToken = randomToken(32);
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString();
  db.prepare<[number, string, string]>(`
    INSERT INTO admin_sessions (admin_id, session_token, expires_at)
    VALUES (?, ?, ?)
  `).run(adminId, sessionToken, expiresAt);
  return { sessionToken, expiresAt };
};

export const getAdminSession = (sessionToken: string): AdminSessionView | undefined => {
  return db.prepare<[string, string], AdminSessionView>(`
    SELECT admin_sessions.*, admin_users.username AS admin_username
    FROM admin_sessions
    JOIN admin_users ON admin_users.id = admin_sessions.admin_id
    WHERE admin_sessions.session_token = ? AND admin_sessions.expires_at > ?
  `).get(sessionToken, nowIso());
};

export const deleteAdminSession = (sessionToken: string): void => {
  db.prepare<[string]>('DELETE FROM admin_sessions WHERE session_token = ?').run(sessionToken);
};

export const purgeExpiredAdminSessions = (): void => {
  db.prepare<[string]>('DELETE FROM admin_sessions WHERE expires_at <= ?').run(nowIso());
};

export const createGatewayToken = (): string => randomToken(24);
