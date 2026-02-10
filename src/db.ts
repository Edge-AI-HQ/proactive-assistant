import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { config } from './config.js';
import type {
  AdminSessionView,
  AdminUserRecord,
  AuthAllowlistKind,
  AuthAllowlistRecord,
  CreateUserInput,
  MessageLogRecord,
  OauthSessionRecord,
  UserMutableFields,
  UserRecord
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
    google_email TEXT UNIQUE NOT NULL,
    google_id TEXT UNIQUE NOT NULL,
    container_id TEXT UNIQUE NOT NULL,
    container_port INTEGER UNIQUE NOT NULL,
    container_status TEXT DEFAULT 'creating',
    gateway_token TEXT UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_active_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS oauth_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_user_id BIGINT NOT NULL,
    telegram_username TEXT,
    state_token TEXT UNIQUE NOT NULL,
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

  CREATE TABLE IF NOT EXISTS auth_allowlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('domain', 'email')),
    value TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (kind, value)
  );
`);

const nowIso = (): string => new Date().toISOString();

const randomToken = (size = 24): string => crypto.randomBytes(size).toString('hex');

export const createOauthSession = (
  telegramUserId: number,
  telegramUsername?: string | null
): { stateToken: string; expiresAt: string } => {
  const stateToken = randomToken(24);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  db.prepare<[number, string | null, string, string]>(`
    INSERT INTO oauth_sessions (telegram_user_id, telegram_username, state_token, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(telegramUserId, telegramUsername || null, stateToken, expiresAt);
  return { stateToken, expiresAt };
};

export const getOauthSession = (stateToken: string): OauthSessionRecord | undefined => {
  return db.prepare<[string, string], OauthSessionRecord>(`
    SELECT * FROM oauth_sessions WHERE state_token = ? AND expires_at > ?
  `).get(stateToken, nowIso());
};

export const consumeOauthSession = (stateToken: string): OauthSessionRecord | null => {
  const session = getOauthSession(stateToken);
  if (!session) return null;
  db.prepare<[string]>('DELETE FROM oauth_sessions WHERE state_token = ?').run(stateToken);
  return session;
};

export const cleanupExpiredOauthSessions = (): void => {
  db.prepare<[string]>('DELETE FROM oauth_sessions WHERE expires_at <= ?').run(nowIso());
};

export const getUserByTelegramId = (telegramUserId: number): UserRecord | undefined => {
  return db.prepare<[number], UserRecord>('SELECT * FROM users WHERE telegram_user_id = ?').get(telegramUserId);
};

export const getUserById = (id: number): UserRecord | undefined => {
  return db.prepare<[number], UserRecord>('SELECT * FROM users WHERE id = ?').get(id);
};

export const getUserByGoogleId = (googleId: string): UserRecord | undefined => {
  return db.prepare<[string], UserRecord>('SELECT * FROM users WHERE google_id = ?').get(googleId);
};

export const getUserByGoogleEmail = (googleEmail: string): UserRecord | undefined => {
  return db.prepare<[string], UserRecord>('SELECT * FROM users WHERE google_email = ?').get(googleEmail);
};

export const listUsers = (): UserRecord[] => {
  return db.prepare<[], UserRecord>('SELECT * FROM users ORDER BY created_at DESC').all();
};

export const createUser = (user: CreateUserInput): UserRecord | undefined => {
  const stmt = db.prepare<
    [number, string | null, string, string, string, number, string, string, string]
  >(`
    INSERT INTO users (
      telegram_user_id,
      telegram_username,
      google_email,
      google_id,
      container_id,
      container_port,
      container_status,
      gateway_token,
      last_active_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    user.telegram_user_id,
    user.telegram_username || null,
    user.google_email,
    user.google_id,
    user.container_id,
    user.container_port,
    user.container_status || 'creating',
    user.gateway_token,
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
    .prepare<[], { container_port: number }>('SELECT container_port FROM users')
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

export const listAuthAllowlist = (kind?: AuthAllowlistKind): AuthAllowlistRecord[] => {
  if (kind) {
    return db
      .prepare<[AuthAllowlistKind], AuthAllowlistRecord>(
        'SELECT * FROM auth_allowlist WHERE kind = ? ORDER BY created_at ASC, id ASC'
      )
      .all(kind);
  }

  return db
    .prepare<[], AuthAllowlistRecord>('SELECT * FROM auth_allowlist ORDER BY created_at ASC, id ASC')
    .all();
};

export const createAuthAllowlistEntry = (kind: AuthAllowlistKind, value: string): AuthAllowlistRecord | undefined => {
  db.prepare<[AuthAllowlistKind, string]>(`
    INSERT OR IGNORE INTO auth_allowlist (kind, value)
    VALUES (?, ?)
  `).run(kind, value);

  return db
    .prepare<[AuthAllowlistKind, string], AuthAllowlistRecord>('SELECT * FROM auth_allowlist WHERE kind = ? AND value = ?')
    .get(kind, value);
};

export const deleteAuthAllowlistEntryById = (id: number): void => {
  db.prepare<[number]>('DELETE FROM auth_allowlist WHERE id = ?').run(id);
};

export const createGatewayToken = (): string => randomToken(24);
