/**
 * LiteLLM virtual key management for proactive-ai users.
 *
 * Reuses the existing LiteLLM client (generateLiteLLMKey, createLiteLLMUser)
 * to provision per-user virtual keys with budget limits. Keys are stored on
 * the `users` table (litellm_virtual_key, litellm_user_id, etc.) — the same
 * columns used by Telegram-based users, avoiding a separate table.
 */

import { pool } from '../common/db/core.js';
import { config } from '../common/config.js';
import {
  createLiteLLMUser,
  generateLiteLLMKey,
  isLiteLLMClientEnabled,
} from '../litellm/client.js';

// ── DB helpers ──

interface UserLiteLLMRow {
  id: number;
  litellm_user_id: string | null;
  litellm_virtual_key: string | null;
  litellm_key_alias: string | null;
  litellm_key_last4: string | null;
  litellm_budget_usd: number | null;
}

async function getLiteLLMFieldsForUser(supabaseUserId: string): Promise<UserLiteLLMRow | null> {
  const { rows } = await pool.query<UserLiteLLMRow>(
    `SELECT id, litellm_user_id, litellm_virtual_key, litellm_key_alias, litellm_key_last4, litellm_budget_usd
     FROM users WHERE supabase_user_id = $1`,
    [supabaseUserId],
  );
  return rows[0] ?? null;
}

async function updateLiteLLMFields(internalUserId: number, params: {
  litellmUserId: string;
  virtualKey: string;
  keyAlias: string | null;
  keyLast4: string | null;
  budgetUsd: number | null;
}): Promise<void> {
  await pool.query(
    `UPDATE users SET
       litellm_user_id = $2,
       litellm_virtual_key = $3,
       litellm_key_alias = $4,
       litellm_key_last4 = $5,
       litellm_budget_usd = $6,
       updated_at = NOW()
     WHERE id = $1`,
    [
      internalUserId,
      params.litellmUserId,
      params.virtualKey,
      params.keyAlias,
      params.keyLast4,
      params.budgetUsd,
    ],
  );
}

// ── Public API ──

const KEY_ALIAS_PREFIX = 'proactive-';
const DEFAULT_BUDGET_USD = 10; // $10 default per-user budget

/**
 * Ensure a proactive user has a LiteLLM virtual key.
 * Returns the key (creates LiteLLM user + key if missing).
 */
export async function ensureProactiveLiteLLMKey(userId: string): Promise<string> {
  if (!config.litellm.enabled) {
    throw new Error('LiteLLM is not enabled — cannot provision proactive key');
  }
  if (!isLiteLLMClientEnabled()) {
    throw new Error('LiteLLM client not configured (missing baseUrl or masterKey)');
  }

  // Check existing key on users table
  const user = await getLiteLLMFieldsForUser(userId);
  if (!user) {
    throw new Error(`User not found for supabase_user_id=${userId}`);
  }

  if (user.litellm_virtual_key?.trim()) {
    return user.litellm_virtual_key;
  }

  // Build identifiers
  const litellmUserId = `proactive-${userId}`;
  const keyAlias = `${KEY_ALIAS_PREFIX}${userId.slice(0, 8)}`;

  // Create LiteLLM user (idempotent — 409 is swallowed)
  await createLiteLLMUser({
    userId: litellmUserId,
    userAlias: `proactive:${userId.slice(0, 8)}`,
    autoCreateKey: false,
    metadata: {
      source: 'proactive-ai',
      proactive_user_id: userId,
    },
  });

  // Generate virtual key with budget
  const allowedModels = config.litellm.allowedModels.length > 0
    ? config.litellm.allowedModels
    : [];

  const generated = await generateLiteLLMKey({
    userId: litellmUserId,
    keyAlias,
    maxBudgetUsd: DEFAULT_BUDGET_USD,
    budgetDuration: config.litellm.defaultBudgetDuration || '30d',
    rpmLimit: config.litellm.defaultRpmLimit ?? null,
    tpmLimit: config.litellm.defaultTpmLimit ?? null,
    models: allowedModels,
    metadata: {
      source: 'proactive-ai',
      proactive_user_id: userId,
    },
  });

  const last4 = generated.rawKey.slice(-4);

  // Persist to users table
  await updateLiteLLMFields(user.id, {
    litellmUserId,
    virtualKey: generated.rawKey,
    keyAlias: generated.keyAlias,
    keyLast4: last4,
    budgetUsd: DEFAULT_BUDGET_USD,
  });

  console.log(`[proactive] Provisioned LiteLLM key for user ${userId.slice(0, 8)} (alias: ${keyAlias})`);
  return generated.rawKey;
}
