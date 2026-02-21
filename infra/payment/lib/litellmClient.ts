interface LiteLLMConfig {
  enabled: boolean;
  baseUrl: string;
  masterKey: string;
  requestTimeoutMs: number;
}

export interface LiteLLMIdentity {
  litellm_user_id: string;
  litellm_user_alias: string;
}

export interface LiteLLMBudgetSyncInput {
  user_id: number;
  telegram_user_id: string;
  telegram_username: string | null;
  litellm_user_id: string | null;
  litellm_user_alias: string | null;
  budget_usd: number;
}

const normalizeBaseUrl = (value: string): string => value.replace(/\/+$/, '');

const readConfig = (): LiteLLMConfig => {
  const enabledRaw = (process.env.LITELLM_ENABLED || '').trim().toLowerCase();
  const baseUrl = normalizeBaseUrl((process.env.LITELLM_BASE_URL || '').trim());
  const masterKey = (process.env.LITELLM_MASTER_KEY || '').trim();

  const enabled = enabledRaw === 'true' || (!!baseUrl && !!masterKey);

  return {
    enabled,
    baseUrl,
    masterKey,
    requestTimeoutMs: Math.max(1000, Number.parseInt(process.env.LITELLM_REQUEST_TIMEOUT_MS || '6000', 10) || 6000)
  };
};

const config = readConfig();

export const isLiteLLMBudgetSyncEnabled = (): boolean =>
  config.enabled && Boolean(config.baseUrl) && Boolean(config.masterKey);

const parseResponsePayload = async (response: Response): Promise<unknown> => {
  const raw = await response.text();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { message: raw };
  }
};

const extractErrorDetail = (payload: unknown): string => {
  if (!payload || typeof payload !== 'object') return '';
  if (typeof (payload as { detail?: unknown }).detail === 'string') return (payload as { detail: string }).detail;
  if (typeof (payload as { error?: unknown }).error === 'string') return (payload as { error: string }).error;
  if (typeof (payload as { message?: unknown }).message === 'string') return (payload as { message: string }).message;
  return '';
};

const requestJson = async (
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
  query?: Record<string, string>
): Promise<unknown> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  const url = new URL(`${config.baseUrl}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (!value.trim()) continue;
      url.searchParams.set(key, value);
    }
  }

  try {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${config.masterKey}`,
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        Accept: 'application/json'
      },
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      signal: controller.signal
    });

    const payload = await parseResponsePayload(response);
    if (!response.ok) {
      const detail = extractErrorDetail(payload);
      throw new Error(`LiteLLM ${path} failed (${response.status})${detail ? `: ${detail}` : ''}`);
    }

    return payload;
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`LiteLLM ${path} timed out after ${config.requestTimeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

const buildDefaultUserId = (userId: number): string => String(Math.max(0, Math.trunc(userId)));

const buildDefaultAlias = (telegramUserId: string, telegramUsername: string | null): string => {
  const username = (telegramUsername || '').trim();
  return username ? `telegram:${telegramUserId}:@${username}` : `telegram:${telegramUserId}`;
};

const DEFAULT_NEW_USER_MAX_BUDGET_USD = 0;

const ensureLiteLLMUser = async (
  identity: LiteLLMIdentity,
  userId: number,
  telegramUserId: string,
  telegramUsername: string | null
): Promise<void> => {
  try {
    await requestJson('POST', '/user/new', {
      user_id: identity.litellm_user_id,
      user_alias: identity.litellm_user_alias,
      max_budget: DEFAULT_NEW_USER_MAX_BUDGET_USD,
      metadata: {
        source: 'infra-payment',
        user_id: userId,
        telegram_user_id: telegramUserId,
        telegram_username: telegramUsername || null
      }
    });
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw error;
    const message = error.message.toLowerCase();
    if (message.includes('already') || message.includes('exists') || message.includes('duplicate')) {
      return;
    }
    throw error;
  }
};

const updateLiteLLMBudget = async (
  identity: LiteLLMIdentity,
  budgetUsd: number,
  userId: number,
  telegramUserId: string,
  telegramUsername: string | null
): Promise<void> => {
  const normalized = Number.isFinite(budgetUsd) ? Math.max(0, Number(budgetUsd.toFixed(6))) : 0;

  try {
    await requestJson('POST', '/user/update', {
      user_id: identity.litellm_user_id,
      user_alias: identity.litellm_user_alias,
      max_budget: normalized
    });
    return;
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw error;
    const lower = error.message.toLowerCase();
    const shouldRetryAfterCreate = lower.includes('not found') || lower.includes('does not exist') || lower.includes('unknown');
    if (!shouldRetryAfterCreate) throw error;
  }

  await ensureLiteLLMUser(identity, userId, telegramUserId, telegramUsername);
  await requestJson('POST', '/user/update', {
    user_id: identity.litellm_user_id,
    user_alias: identity.litellm_user_alias,
    max_budget: normalized
  });
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

const readNumber = (record: Record<string, unknown> | null, keys: string[]): number | null => {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number.parseFloat(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
};

const readUserSpendUsd = (payload: unknown): number | null => {
  const root = asRecord(payload);
  if (!root) return null;

  const direct = readNumber(root, ['spend', 'spend_usd', 'total_spend']);
  if (direct !== null) return direct;

  const data = asRecord(root.data);
  const fromData = readNumber(data, ['spend', 'spend_usd', 'total_spend']);
  if (fromData !== null) return fromData;

  const info = asRecord(root.info ?? data?.info ?? data?.user_info);
  return readNumber(info, ['spend', 'spend_usd', 'total_spend']);
};

export const getLiteLLMUserSpendCents = async (litellmUserId: string): Promise<number | null> => {
  if (!isLiteLLMBudgetSyncEnabled()) return null;
  const userId = (litellmUserId || '').trim();
  if (!userId) return null;

  let payload: unknown;
  try {
    payload = await requestJson('GET', '/user/info', undefined, { user_id: userId });
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw error;
    const lower = error.message.toLowerCase();
    const shouldFallbackToPost = lower.includes('(404)') || lower.includes('(405)') || lower.includes('method not allowed');
    if (!shouldFallbackToPost) throw error;
    payload = await requestJson('POST', '/user/info', { user_id: userId });
  }

  const spendUsd = readUserSpendUsd(payload);
  if (spendUsd === null) return null;
  return Math.max(0, Math.trunc(spendUsd * 100));
};

export const syncLiteLLMBudgetForUser = async (input: LiteLLMBudgetSyncInput): Promise<LiteLLMIdentity | null> => {
  if (!isLiteLLMBudgetSyncEnabled()) return null;

  const identity: LiteLLMIdentity = {
    litellm_user_id: (input.litellm_user_id || '').trim() || buildDefaultUserId(input.user_id),
    litellm_user_alias:
      (input.litellm_user_alias || '').trim() || buildDefaultAlias(input.telegram_user_id, input.telegram_username)
  };

  await ensureLiteLLMUser(identity, input.user_id, input.telegram_user_id, input.telegram_username);
  await updateLiteLLMBudget(identity, input.budget_usd, input.user_id, input.telegram_user_id, input.telegram_username);

  return identity;
};
