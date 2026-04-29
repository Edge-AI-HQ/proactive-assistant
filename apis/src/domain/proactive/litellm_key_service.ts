/**
 * LiteLLM virtual key management for proactive-ai users.
 *
 * Reuses the existing LiteLLM client (generateLiteLLMKey, createLiteLLMUser)
 * to provision per-user virtual keys with budget limits. Keys are cached on
 * the `users` table (litellm_virtual_key, litellm_user_id, litellm_key_alias,
 * litellm_key_last4, litellm_budget_usd); LiteLLM itself remains the source
 * of truth for the key state.
 */

import { pool } from '../common/db/core.js';
import { config } from '../common/config.js';
import {
  createLiteLLMUser,
  generateLiteLLMKey,
  deleteLiteLLMKey,
  listLiteLLMKeysForUser,
  isLiteLLMClientEnabled,
} from '../litellm/client.js';

/** LiteLLM virtual keys always start with this prefix. */
const LITELLM_VIRTUAL_KEY_PREFIX = 'sk-';

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

  // DB is the single source of truth for usable keys. Only trust sk-* values;
  // anything else (NULL, empty, or a hashed token from a previous bug) is stale.
  const cachedKey = user.litellm_virtual_key?.trim();
  if (cachedKey && cachedKey.startsWith(LITELLM_VIRTUAL_KEY_PREFIX)) {
    return cachedKey;
  }

  // ── Need a fresh key: clean up any orphan in LiteLLM, then generate. ──

  const litellmUserId = `proactive-${userId}`;
  const keyAlias = `${KEY_ALIAS_PREFIX}${userId.slice(0, 8)}`;

  // Create LiteLLM user (idempotent — 409 is swallowed)
  await createLiteLLMUser({
    userId: litellmUserId,
    userAlias: `proactive:${userId.slice(0, 8)}`,
    autoCreateKey: false,
    metadata: { source: 'proactive-ai', proactive_user_id: userId },
  });

  // Delete any pre-existing key for this alias so we don't accumulate orphans.
  // NOTE: LiteLLM /user/info returns hashed tokens, not the original sk-* key,
  // so we can never recover a lost key — only replace it.
  const existingKeys = await listLiteLLMKeysForUser(litellmUserId);
  const staleKey = existingKeys.find((k) => k.keyAlias === keyAlias);
  if (staleKey) {
    await deleteLiteLLMKey([staleKey.token]).catch(() => {});
  }

  // Generate a fresh virtual key
  const generated = await generateLiteLLMKey({
    userId: litellmUserId,
    keyAlias,
    maxBudgetUsd: DEFAULT_BUDGET_USD,
    budgetDuration: config.litellm.defaultBudgetDuration || '30d',
    rpmLimit: config.litellm.defaultRpmLimit ?? null,
    tpmLimit: config.litellm.defaultTpmLimit ?? null,
    models: config.litellm.allowedModels.length > 0 ? config.litellm.allowedModels : [],
    metadata: { source: 'proactive-ai', proactive_user_id: userId },
  });

  // Persist to users table
  await updateLiteLLMFields(user.id, {
    litellmUserId,
    virtualKey: generated.rawKey,
    keyAlias: generated.keyAlias ?? keyAlias,
    keyLast4: generated.rawKey.slice(-4),
    budgetUsd: DEFAULT_BUDGET_USD,
  });

  console.log(`[proactive] Provisioned LiteLLM key for user ${userId.slice(0, 8)} (alias: ${keyAlias})`);
  return generated.rawKey;
}
