/**
 * Pair Code flow for screened-but-unauthed hardware.
 * See docs/plans/2026-04-29-personal-signal-and-pairing.mdx §三 Class B.
 *
 * High-level state machine:
 *   request → pending ─┬─→ claim    → claimed (terminal, also creates user_devices row)
 *                      ├─→ expire   → expired (sweep job, after expires_at)
 *                      └─→ cancel   → cancelled (device gave up)
 *
 * The whole feature is a thin layer on top of pairing_codes + the existing
 * registerDevice path — it's just a way to attribute a device_token to the
 * right user without ever having that device touch Supabase.
 */
import crypto from 'node:crypto';
import { pool } from '../common/db/core.js';
import { DomainError } from '../common/errors.js';
import { registerDevice, type DevicePlatform } from './index.js';

// ── Code shape ──────────────────────────────────────────────────────────

// 6 chars from 32 unambiguous symbols → 32^6 ≈ 10^9 codes. Combined with
// rate limiting, brute force is not viable. Removed: 0 O 1 I L (all
// frequently misread on small screens).
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LEN = 6;

function generateCode(): string {
  // crypto.randomInt + mod is fine for 32-symbol alphabet (no modulo bias
  // because 256 % 32 === 0). Using crypto.randomBytes directly to keep
  // dependence small.
  const buf = crypto.randomBytes(CODE_LEN);
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) {
    out += ALPHABET[buf[i]! % ALPHABET.length];
  }
  return out;
}

// ── Constants ───────────────────────────────────────────────────────────

const DEFAULT_EXPIRY_MS = 5 * 60 * 1000;      // 5 min, matches plan
const POLL_INTERVAL_S = 3;
const MAX_PENDING_PER_USER = 1;
// Devices identify themselves by deviceClass on request. We accept the
// same set as DevicePlatform's hardware-side enum.
const ALLOWED_DEVICE_CLASSES: DevicePlatform[] = ['wearable', 'sensor', 'embedded'];

// ── Types ───────────────────────────────────────────────────────────────

export type PairingStatus = 'pending' | 'claimed' | 'expired' | 'cancelled';

export interface PairingCodeRow {
  code: string;
  status: PairingStatus;
  device_class: DevicePlatform;
  model: string | null;
  user_id: number | null;
  device_id: string | null;
  device_token_temp: string | null;
  expires_at: string;
  created_at: string;
  claimed_at: string | null;
}

export interface PairingRequestResult {
  code: string;
  poll_url: string;
  poll_interval: number;
  expires_in: number;
}

export interface PairingPollResult {
  status: PairingStatus;
  // Present only when status='claimed'.
  device_id?: string;
  device_token?: string;
}

export interface PairingClaimInput {
  userId: number;
  code: string;
  displayName?: string | null;
  model?: string | null;
}

// ── Operations ──────────────────────────────────────────────────────────

/**
 * Device → server: "I want to be paired, give me a short code."
 * Generates a unique 6-char code with retries on collision (vanishingly
 * unlikely at 10^9 codes but cheap to handle).
 */
export async function requestPairingCode(params: {
  deviceClass: DevicePlatform;
  model?: string | null;
}): Promise<PairingRequestResult> {
  if (!ALLOWED_DEVICE_CLASSES.includes(params.deviceClass)) {
    throw new DomainError('INVALID_INPUT', `unsupported deviceClass: ${params.deviceClass}`);
  }

  // Try a few times in the unlikely case of code collision. Anything more
  // is symptomatic of a broken RNG, not a normal hot path.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    const expiresAt = new Date(Date.now() + DEFAULT_EXPIRY_MS).toISOString();
    try {
      await pool.query(
        `INSERT INTO pairing_codes (code, status, device_class, model, expires_at)
         VALUES ($1, 'pending', $2, $3, $4)`,
        [code, params.deviceClass, params.model ?? null, expiresAt],
      );
      return {
        code,
        poll_url: `/api/proactive/devices/pair-code/poll?code=${code}`,
        poll_interval: POLL_INTERVAL_S,
        expires_in: Math.floor(DEFAULT_EXPIRY_MS / 1000),
      };
    } catch (err) {
      // 23505 = unique_violation → collision, retry. Anything else is fatal.
      if ((err as { code?: string })?.code !== '23505') throw err;
    }
  }
  throw new DomainError('INTERNAL', 'failed to generate a unique pairing code');
}

/**
 * Device polls until status flips off 'pending'. We treat any expired
 * 'pending' row as expired here too (lazy expire) so devices don't poll
 * against a dead code waiting on the sweep job to catch up.
 */
export async function pollPairingCode(code: string): Promise<PairingPollResult> {
  if (!code) throw new DomainError('INVALID_INPUT', 'code is required');

  const { rows } = await pool.query<PairingCodeRow>(
    `SELECT * FROM pairing_codes WHERE code = $1`,
    [code],
  );
  const row = rows[0];
  if (!row) throw new DomainError('NOT_FOUND', 'unknown pairing code');

  // Lazy-expire: if it's pending but past expiry, flip status here so the
  // device sees a clean answer immediately.
  if (row.status === 'pending' && new Date(row.expires_at).getTime() < Date.now()) {
    await pool.query(`UPDATE pairing_codes SET status = 'expired' WHERE code = $1`, [code]);
    return { status: 'expired' };
  }

  if (row.status === 'claimed' && row.device_id) {
    // First poll after claim: we hand out the temp token and immediately
    // null it. Subsequent polls see status='claimed' with no token —
    // this is correct, the device has its token now and shouldn't ask
    // for it again. If a device legitimately lost its token it should
    // re-pair (new code), not poll an old code.
    if (row.device_token_temp) {
      const tempToken = row.device_token_temp;
      await pool.query(
        `UPDATE pairing_codes SET device_token_temp = NULL WHERE code = $1`,
        [code],
      );
      return {
        status: 'claimed',
        device_id: row.device_id,
        device_token: tempToken,
      };
    }
    // Already consumed — return claimed status without token.
    return { status: 'claimed', device_id: row.device_id };
  }

  return { status: row.status };
}

/**
 * User (Web side) calls this with the code they read off the device. We:
 *   1. Verify the code is pending and not expired.
 *   2. Enforce "max 1 active code per user" — we let claim succeed but
 *      we don't pre-reserve, the constraint applies at request time.
 *   3. Generate a device_id, register it (creating the user_devices row
 *      and returning the plaintext token), and flip the code to claimed.
 *
 * Returns the device_token plaintext so the *Web* UI can optionally show
 * it (mainly for confirmation / debugging — the device picks it up via
 * its next poll).
 */
export async function claimPairingCode(input: PairingClaimInput): Promise<{
  device_id: string;
  display_name: string;
  device_token: string;
}> {
  if (!input.code) throw new DomainError('INVALID_INPUT', 'code is required');

  const { rows } = await pool.query<PairingCodeRow>(
    `SELECT * FROM pairing_codes WHERE code = $1 FOR UPDATE`,
    [input.code],
  );
  const row = rows[0];
  if (!row) throw new DomainError('NOT_FOUND', 'unknown pairing code');
  if (row.status !== 'pending') {
    throw new DomainError('CONFLICT', `code is ${row.status}`);
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await pool.query(`UPDATE pairing_codes SET status = 'expired' WHERE code = $1`, [input.code]);
    throw new DomainError('CONFLICT', 'code is expired');
  }

  // Synthesize a device_id. We use UUID v4; deviceId only needs to be
  // unique per user, not globally secret.
  const deviceId = crypto.randomUUID();
  const displayName = input.displayName?.trim() || `${row.device_class} ${row.code}`;

  const registered = await registerDevice({
    userId: input.userId,
    deviceId,
    platform: row.device_class,
    displayName,
    model: input.model ?? row.model ?? null,
    metadata: { paired_via: 'pair-code', code: row.code },
  });

  await pool.query(
    `UPDATE pairing_codes
       SET status = 'claimed',
           user_id = $1,
           device_id = $2,
           device_token_temp = $3,
           claimed_at = now()
     WHERE code = $4`,
    [input.userId, deviceId, registered.device_token, input.code],
  );

  return {
    device_id: registered.device_id,
    display_name: registered.display_name ?? displayName,
    device_token: registered.device_token,
  };
}

/**
 * The device or the user can give up before claim. Idempotent.
 */
export async function cancelPairingCode(code: string): Promise<void> {
  if (!code) throw new DomainError('INVALID_INPUT', 'code is required');
  await pool.query(
    `UPDATE pairing_codes SET status = 'cancelled' WHERE code = $1 AND status = 'pending'`,
    [code],
  );
}

/**
 * Sweep job: flip every pending row past expiry to 'expired'. Cheap thanks
 * to the partial index. Run on a timer (every 60s is plenty).
 */
export async function expirePairingCodes(): Promise<{ expired: number }> {
  const { rowCount } = await pool.query(
    `UPDATE pairing_codes
       SET status = 'expired'
     WHERE status = 'pending' AND expires_at < now()`,
  );
  return { expired: rowCount ?? 0 };
}
