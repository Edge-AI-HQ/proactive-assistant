/**
 * user_devices — multi-device registry.
 * See docs/plans/memory-architecture.mdx §三 (APIs user_devices) and migration 002.
 *
 * Token lifecycle:
 *   1. Client calls POST /api/proactive/devices/register with deviceId + platform.
 *   2. Server generates a 256-bit random token, bcrypt-hashes it, stores
 *      the hash, returns the plaintext token ONCE.
 *   3. Client stores the plaintext (Capacitor Preferences / iOS Keychain /
 *      Android EncryptedSharedPreferences / web localStorage).
 *   4. Subsequent /api/mobile/* calls send X-Device-Id + X-Device-Token.
 *      Server looks up the device, bcrypt-compares, routes to the user's
 *      container.
 */
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { pool } from '../common/db/core.js';
import { DomainError } from '../common/errors.js';

export type DevicePlatform =
  | 'ios'
  | 'android'
  | 'web'
  | 'wearable'   // omi pendant / friend / 智能项链等
  | 'sensor'     // 智能戒指 / 健康设备等无屏被动设备
  | 'embedded';  // 兜底(未来 ESP32 自研硬件等)

const VALID_PLATFORMS: ReadonlySet<DevicePlatform> = new Set([
  'ios', 'android', 'web', 'wearable', 'sensor', 'embedded',
]);

export interface UserDeviceRow {
  id: number;
  device_id: string;
  user_id: number;
  platform: DevicePlatform;
  display_name: string | null;
  app_version: string | null;
  model: string | null;
  registered_at: string;
  last_seen_at: string | null;
  status: 'active' | 'revoked';
  metadata: Record<string, unknown>;
}

export interface RegisteredDevice extends UserDeviceRow {
  /** Plaintext token, returned ONLY on registration. */
  device_token: string;
}

const TOKEN_BYTES = 32;
const BCRYPT_ROUNDS = 10;

function generateToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * Register a new device, OR rotate the token of an existing device that
 * the same user already owns. Returns the plaintext token (only this once).
 *
 * Rotation policy: if `device_id` already exists and belongs to the same
 * user, the token is rotated. If it belongs to a different user, throws
 * an "owner_mismatch" error.
 */
export async function registerDevice(params: {
  userId: number;
  deviceId: string;
  platform: DevicePlatform;
  displayName?: string | null;
  appVersion?: string | null;
  model?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<RegisteredDevice> {
  if (!params.deviceId || params.deviceId.trim().length < 8) {
    throw new DomainError('INVALID_INPUT', 'deviceId must be at least 8 characters');
  }
  if (!VALID_PLATFORMS.has(params.platform)) {
    throw new DomainError('INVALID_INPUT', `unsupported platform: ${params.platform}`);
  }

  const token = generateToken();
  const tokenHash = await bcrypt.hash(token, BCRYPT_ROUNDS);
  const metadataJson = JSON.stringify(params.metadata ?? {});

  // Look up first to enforce ownership
  const existing = await pool.query<UserDeviceRow>(
    `SELECT * FROM user_devices WHERE device_id = $1`,
    [params.deviceId],
  );
  if (existing.rows.length > 0) {
    const row = existing.rows[0]!;
    if (row.user_id !== params.userId) {
      throw new DomainError('CONFLICT', 'device_id is registered to a different user');
    }
    // Same user → rotate token + refresh metadata
    const { rows } = await pool.query<UserDeviceRow>(
      `UPDATE user_devices
         SET device_token_hash = $1, platform = $2, display_name = $3,
             app_version = $4, model = $5, metadata = $6::jsonb,
             status = 'active', registered_at = now(), last_seen_at = now()
       WHERE device_id = $7
       RETURNING *`,
      [tokenHash, params.platform, params.displayName ?? null,
       params.appVersion ?? null, params.model ?? null, metadataJson, params.deviceId],
    );
    return { ...rows[0]!, device_token: token };
  }

  const { rows } = await pool.query<UserDeviceRow>(
    `INSERT INTO user_devices
       (device_id, user_id, device_token_hash, platform, display_name, app_version, model, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     RETURNING *`,
    [params.deviceId, params.userId, tokenHash, params.platform,
     params.displayName ?? null, params.appVersion ?? null,
     params.model ?? null, metadataJson],
  );
  return { ...rows[0]!, device_token: token };
}

export async function listDevicesForUser(userId: number): Promise<UserDeviceRow[]> {
  const { rows } = await pool.query<UserDeviceRow>(
    `SELECT * FROM user_devices
     WHERE user_id = $1 AND status = 'active'
     ORDER BY last_seen_at DESC NULLS LAST, registered_at DESC`,
    [userId],
  );
  return rows;
}

export async function revokeDevice(params: {
  userId: number;
  deviceId: string;
}): Promise<UserDeviceRow | null> {
  const { rows } = await pool.query<UserDeviceRow>(
    `UPDATE user_devices SET status = 'revoked'
     WHERE device_id = $1 AND user_id = $2
     RETURNING *`,
    [params.deviceId, params.userId],
  );
  return rows[0] ?? null;
}

/**
 * Look up a device by device_id and verify the supplied token. Returns
 * the device row + user_id when valid; null on any mismatch (do not leak
 * which check failed).
 */
export async function findDeviceByToken(
  deviceId: string,
  token: string,
): Promise<UserDeviceRow | null> {
  if (!deviceId || !token) return null;
  const { rows } = await pool.query<UserDeviceRow & { device_token_hash: string }>(
    `SELECT * FROM user_devices WHERE device_id = $1 AND status = 'active'`,
    [deviceId],
  );
  const row = rows[0];
  if (!row) return null;
  const ok = await bcrypt.compare(token, row.device_token_hash);
  if (!ok) return null;
  // Touch last_seen_at; fire-and-forget — no need to block.
  void pool.query(
    `UPDATE user_devices SET last_seen_at = now() WHERE id = $1`, [row.id],
  ).catch(() => undefined);
  // Return without the hash column (caller doesn't need it).
  return {
    id: row.id,
    device_id: row.device_id,
    user_id: row.user_id,
    platform: row.platform,
    display_name: row.display_name,
    app_version: row.app_version,
    model: row.model,
    registered_at: row.registered_at,
    last_seen_at: row.last_seen_at,
    status: row.status,
    metadata: row.metadata,
  };
}
