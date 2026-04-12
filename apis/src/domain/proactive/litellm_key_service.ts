/**
 * LiteLLM virtual key management for proactive-ai users.
 *
 * Reuses the existing LiteLLM client (generateLiteLLMKey, createLiteLLMUser)
 * to provision per-user virtual keys with budget limits. Keys are stored in
 * the proactive_litellm_keys table (one key per user).
 */

import { pool } from '../common/db/core.js';
import { config } from '../common/config.js';
import {
  createLiteLLMUser,
  generateLiteLLMKey,
  isLiteLLMClientEnabled,
} from '../litellm/client.js';

export interface ProactiveLiteLLMKey {
  user_id: string;
  litellm_user_id: string;
  virtual_key: string;
  key_alias: string | null;
  key_last4: string | null;
  spend_usd: number;
  budget_usd: number | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

// ── DB helpers ──

async function getKeyForUser(userId: string): Promise<ProactiveLiteLLMKey | null> {
  const { rows } = await pool.query<ProactiveLiteLLMKey>(
    `SELECT * FROM proactive_litellm_keys WHERE user_id = $1`,
    [userId],
  );
  return rows[0] ?? null;
}

async function upsertKey(params: {
  userId: string;
  litellmUserId: string;
  virtualKey: string;
  keyAlias: string | null;
  keyLast4: string | null;
  budgetUsd: number | null;
}): Promise<ProactiveLiteLLMKey> {
  const { rows } = await pool.query<ProactiveLiteLLMKey>(
    `INSERT INTO proactive_litellm_keys (user_id, litellm_user_id, virtual_key, key_alias, key_last4, budget_usd)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id) DO UPDATE SET
       litellm_user_id = EXCLUDED.litellm_user_id,
       virtual_key = EXCLUDED.virtual_key,
       key_alias = EXCLUDED.key_alias,
       key_last4 = EXCLUDED.key_last4,
       budget_usd = EXCLUDED.budget_usd,
       updated_at = NOW()
     RETURNING *`,
    [
      params.userId,
      params.litellmUserId,
      params.virtualKey,
      params.keyAlias,
      params.keyLast4,
      params.budgetUsd,
    ],
  );
  return rows[0]!;
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

  // Check DB first
  const existing = await getKeyForUser(userId);
  if (existing?.virtual_key) {
    return existing.virtual_key;
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

  // Persist to DB
  await upsertKey({
    userId,
    litellmUserId,
    virtualKey: generated.rawKey,
    keyAlias: generated.keyAlias,
    keyLast4: last4,
    budgetUsd: DEFAULT_BUDGET_USD,
  });

  console.log(`[proactive] Provisioned LiteLLM key for user ${userId.slice(0, 8)} (alias: ${keyAlias})`);
  return generated.rawKey;
}
