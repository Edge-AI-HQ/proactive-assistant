import { getLiteLLMRuntime } from './runtime.js';

const config = new Proxy({} as { litellm: ReturnType<typeof getLiteLLMRuntime>['config']['litellm'] }, {
  get: (_target, prop) => getLiteLLMRuntime().config[prop as keyof ReturnType<typeof getLiteLLMRuntime>['config']]
});

type JsonRecord = Record<string, unknown>;

interface LiteLLMCreateUserInput {
  userId: string;
  userAlias: string;
  keyAlias?: string | null;
  maxBudgetUsd?: number | null;
  metadata?: JsonRecord;
  autoCreateKey?: boolean;
}

interface LiteLLMUpdateUserInput {
  userId: string;
  userAlias?: string | null;
  maxBudgetUsd?: number | null;
  metadata?: JsonRecord;
}

interface LiteLLMGenerateKeyInput {
  userId: string;
  keyAlias: string;
  maxBudgetUsd: number | null;
  budgetDuration: string;
  rpmLimit: number | null;
  tpmLimit: number | null;
  models: string[];
  metadata?: JsonRecord;
}

export interface LiteLLMGeneratedKey {
  rawKey: string;
  keyAlias: string | null;
  userId: string | null;
  maxBudgetUsd: number | null;
  budgetDuration: string | null;
  rpmLimit: number | null;
  tpmLimit: number | null;
  raw: unknown;
}

export interface LiteLLMVirtualKeyInfo {
  spendUsd: number;
  maxBudgetUsd: number | null;
  budgetDuration: string | null;
  rpmLimit: number | null;
  tpmLimit: number | null;
  keyAlias: string | null;
  userId: string | null;
  raw: unknown;
}

export interface LiteLLMUserInfo {
  userId: string | null;
  userAlias: string | null;
  spendUsd: number | null;
  maxBudgetUsd: number | null;
  budgetDuration: string | null;
  rpmLimit: number | null;
  tpmLimit: number | null;
  raw: unknown;
}

export interface LiteLLMCreateUserResult {
  rawKey: string | null;
  keyAlias: string | null;
  userId: string | null;
  maxBudgetUsd: number | null;
  budgetDuration: string | null;
  rpmLimit: number | null;
  tpmLimit: number | null;
  raw: unknown;
}

const isRecord = (value: unknown): value is JsonRecord => typeof value === 'object' && value !== null;

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

const extractErrorDetail = (value: unknown): string | null => {
  if (!isRecord(value)) return null;

  const direct = readString(value, ['error', 'message', 'detail']);
  if (direct) return direct;

  const errorValue = value.error;
  if (isRecord(errorValue)) {
    const nested = readString(errorValue, ['message', 'detail', 'type', 'code']);
    if (nested) return nested;
  }

  return null;
};

const readString = (obj: JsonRecord, keys: string[]): string | null => {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
};

const readNumber = (obj: JsonRecord, keys: string[]): number | null => {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number.parseFloat(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
};

const normalizeBudgetUsd = (value: number | null): number => {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return Math.max(0, Number(parsed.toFixed(6)));
};

const normalizeOptionalBudgetUsd = (value: number | null | undefined): number | null => {
  if (value === undefined) return null;
  return normalizeBudgetUsd(value ?? 0);
};

const apiUrl = (path: string): string => `${config.litellm.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;

export const isLiteLLMClientEnabled = (): boolean => {
  return config.litellm.enabled && Boolean(config.litellm.baseUrl.trim()) && Boolean(config.litellm.masterKey.trim());
};

const requestJson = async (
  method: 'GET' | 'POST',
  path: string,
  params?: JsonRecord,
  bearerToken?: string
): Promise<unknown> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.litellm.requestTimeoutMs);
  const url = new URL(apiUrl(path));

  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${bearerToken || config.litellm.masterKey}`
  };

  let body: string | undefined;

  if (method === 'GET' && params && Object.keys(params).length > 0) {
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      url.searchParams.set(key, String(value));
    });
  }

  if (method === 'POST') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(params ?? {});
  }

  try {
    const requestInit: RequestInit = {
      method,
      headers,
      signal: controller.signal
    };
    if (body !== undefined) {
      requestInit.body = body;
    }

    const response = await fetch(url, requestInit);

    const rawText = await response.text();
    let parsed: unknown = null;

    if (rawText) {
      try {
        parsed = JSON.parse(rawText) as unknown;
      } catch {
        parsed = { message: rawText };
      }
    }

    if (!response.ok) {
      const detail = extractErrorDetail(parsed);
      throw new Error(`LiteLLM ${method} ${path} failed (${response.status})${detail ? `: ${detail}` : ''}`);
    }

    return parsed;
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`LiteLLM ${method} ${path} timed out after ${config.litellm.requestTimeoutMs}ms`);
    }
    if (error instanceof Error) {
      if (error.message.startsWith('LiteLLM ')) throw error;
      const withCause = error as Error & { cause?: unknown };
      const causeMessage =
        withCause.cause instanceof Error
          ? withCause.cause.message
          : typeof withCause.cause === 'string'
            ? withCause.cause
            : '';
      const detail = causeMessage || error.message;
      throw new Error(`LiteLLM ${method} ${path} request failed (${url.origin}): ${detail}`);
    }
    throw new Error(`LiteLLM ${method} ${path} request failed (${url.origin})`);
  } finally {
    clearTimeout(timeout);
  }
};

const maybeNestedRecord = (value: unknown, keys: string[]): JsonRecord | null => {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const nested = value[key];
    if (isRecord(nested)) return nested;
  }
  return value;
};

const buildUserInfoRecords = (payload: unknown): JsonRecord[] => {
  const records: JsonRecord[] = [];
  const push = (value: unknown): void => {
    if (!isRecord(value)) return;
    if (!records.includes(value)) records.push(value);
  };

  push(payload);

  const root = isRecord(payload) ? payload : null;
  if (!root) return records;

  push(root.data);
  push(root.info);
  push(root.user_info);

  const data = isRecord(root.data) ? root.data : null;
  if (data) {
    push(data.info);
    push(data.user_info);
  }

  const info = isRecord(root.info) ? root.info : null;
  if (info) {
    push(info.user_info);
  }

  return records;
};

const readStringFromRecords = (records: JsonRecord[], keys: string[]): string | null => {
  for (const record of records) {
    const value = readString(record, keys);
    if (value) return value;
  }
  return null;
};

const readNumberFromRecords = (records: JsonRecord[], keys: string[]): number | null => {
  for (const record of records) {
    const value = readNumber(record, keys);
    if (value !== null) return value;
  }
  return null;
};

const shouldFallbackToPost = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    /\((404|405)\)/.test(message) ||
    message.includes('method not allowed') ||
    message.includes('not found')
  );
};

const isAutoCreateKeyRejected = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  const mentionsField = message.includes('auto_create_key') || message.includes('auto create key');
  if (!mentionsField) return false;
  return (
    message.includes('extra fields') ||
    message.includes('not permitted') ||
    message.includes('unexpected') ||
    message.includes('validation') ||
    message.includes('unknown') ||
    message.includes('invalid')
  );
};

const updateLiteLLMKeyBudget = async (rawKey: string, maxBudgetUsd: number): Promise<void> => {
  await requestJson('POST', '/key/update', {
    key: rawKey,
    max_budget: maxBudgetUsd
  });
};

export const createLiteLLMUser = async (input: LiteLLMCreateUserInput): Promise<LiteLLMCreateUserResult> => {
  if (!isNonEmptyString(input.userId)) {
    throw new Error('LiteLLM user_id is required');
  }
  if (!isNonEmptyString(input.userAlias)) {
    throw new Error('LiteLLM user_alias is required');
  }

  const autoCreateKey = input.autoCreateKey ?? true;
  const body: JsonRecord = {
    user_id: input.userId,
    user_alias: input.userAlias,
    auto_create_key: autoCreateKey
  };
  if (isNonEmptyString(input.keyAlias)) {
    body.key_alias = input.keyAlias.trim();
  }

  const normalizedMaxBudget = normalizeOptionalBudgetUsd(input.maxBudgetUsd);
  if (normalizedMaxBudget !== null) {
    body.max_budget = normalizedMaxBudget;
  }
  if (input.metadata && Object.keys(input.metadata).length > 0) {
    body.metadata = input.metadata;
  }

  try {
    const parsed = await requestJson('POST', '/user/new', body);
    const records = buildUserInfoRecords(parsed);
    const payload = maybeNestedRecord(parsed, ['data', 'key_info']) ?? (isRecord(parsed) ? parsed : null);
    const rawKey = payload ? readString(payload, ['key', 'token', 'virtual_key']) : null;
    const result: LiteLLMCreateUserResult = {
      rawKey,
      keyAlias:
        (payload ? readString(payload, ['key_alias', 'key_name']) : null) ??
        readStringFromRecords(records, ['key_alias', 'key_name']),
      userId: readStringFromRecords(records, ['user_id']) ?? input.userId,
      maxBudgetUsd: readNumberFromRecords(records, ['max_budget', 'budget']) ?? normalizedMaxBudget,
      budgetDuration: readStringFromRecords(records, ['budget_duration']),
      rpmLimit: readNumberFromRecords(records, ['rpm_limit']),
      tpmLimit: readNumberFromRecords(records, ['tpm_limit']),
      raw: parsed
    };

    // LiteLLM /user/new applies max_budget to user profile, but auto-created key can still be unlimited.
    // Force-align key max_budget so dashboard/API show the expected per-key limit.
    if (rawKey && normalizedMaxBudget !== null) {
      await updateLiteLLMKeyBudget(rawKey, normalizedMaxBudget);
      result.maxBudgetUsd = normalizedMaxBudget;
    }

    return result;
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw error;
    const lower = error.message.toLowerCase();
    if (lower.includes('already') || lower.includes('exists') || lower.includes('duplicate')) {
      return {
        rawKey: null,
        keyAlias: null,
        userId: input.userId,
        maxBudgetUsd: normalizedMaxBudget,
        budgetDuration: null,
        rpmLimit: null,
        tpmLimit: null,
        raw: null
      };
    }
    if (!autoCreateKey && isAutoCreateKeyRejected(error)) {
      throw new Error(
        'LiteLLM /user/new rejected auto_create_key=false. Upgrade LiteLLM to keep one-key-per-user semantics.'
      );
    }
    throw error;
  }
};

export const updateLiteLLMUser = async (input: LiteLLMUpdateUserInput): Promise<void> => {
  if (!isNonEmptyString(input.userId)) {
    throw new Error('LiteLLM user_id is required');
  }

  const body: JsonRecord = {
    user_id: input.userId
  };

  if (isNonEmptyString(input.userAlias)) {
    body.user_alias = input.userAlias.trim();
  }

  const normalizedMaxBudget = normalizeOptionalBudgetUsd(input.maxBudgetUsd);
  if (normalizedMaxBudget !== null) {
    body.max_budget = normalizedMaxBudget;
  }

  if (input.metadata && Object.keys(input.metadata).length > 0) {
    body.metadata = input.metadata;
  }

  await requestJson('POST', '/user/update', body);
};

export const generateLiteLLMKey = async (input: LiteLLMGenerateKeyInput): Promise<LiteLLMGeneratedKey> => {
  const body: JsonRecord = {
    user_id: input.userId,
    key_alias: input.keyAlias,
    budget_duration: input.budgetDuration
  };

  if (input.maxBudgetUsd !== null) body.max_budget = input.maxBudgetUsd;
  if (input.rpmLimit !== null) body.rpm_limit = input.rpmLimit;
  if (input.tpmLimit !== null) body.tpm_limit = input.tpmLimit;
  if (input.models.length) body.models = input.models;
  if (input.metadata && Object.keys(input.metadata).length > 0) {
    body.metadata = input.metadata;
  }

  const parsed = await requestJson('POST', '/key/generate', body);
  const payload = maybeNestedRecord(parsed, ['data', 'key_info']);
  if (!payload) {
    throw new Error('LiteLLM /key/generate returned invalid payload');
  }

  const rawKey = readString(payload, ['key', 'token', 'virtual_key']);
  if (!rawKey) {
    throw new Error('LiteLLM /key/generate did not return virtual key material');
  }

  return {
    rawKey,
    keyAlias: readString(payload, ['key_alias', 'key_name']) ?? input.keyAlias,
    userId: readString(payload, ['user_id']) ?? input.userId,
    maxBudgetUsd: readNumber(payload, ['max_budget', 'budget']) ?? input.maxBudgetUsd,
    budgetDuration: readString(payload, ['budget_duration']) ?? input.budgetDuration,
    rpmLimit: readNumber(payload, ['rpm_limit']) ?? input.rpmLimit,
    tpmLimit: readNumber(payload, ['tpm_limit']) ?? input.tpmLimit,
    raw: parsed
  };
};

export const getLiteLLMUserInfo = async (litellmUserId: string): Promise<LiteLLMUserInfo> => {
  const userId = litellmUserId.trim();
  if (!userId) {
    throw new Error('LiteLLM user_id is required');
  }

  let parsed: unknown;

  try {
    parsed = await requestJson('GET', '/user/info', { user_id: userId });
  } catch (error: unknown) {
    if (!shouldFallbackToPost(error)) throw error;
    parsed = await requestJson('POST', '/user/info', { user_id: userId });
  }

  const records = buildUserInfoRecords(parsed);

  return {
    userId: readStringFromRecords(records, ['user_id']) ?? userId,
    userAlias: readStringFromRecords(records, ['user_alias']),
    spendUsd: readNumberFromRecords(records, ['spend', 'spend_usd', 'total_spend', 'current_spend']),
    maxBudgetUsd: readNumberFromRecords(records, ['max_budget', 'budget']),
    budgetDuration: readStringFromRecords(records, ['budget_duration']),
    rpmLimit: readNumberFromRecords(records, ['rpm_limit']),
    tpmLimit: readNumberFromRecords(records, ['tpm_limit']),
    raw: parsed
  };
};

export const getLiteLLMUserSpendCents = async (litellmUserId: string): Promise<number | null> => {
  const info = await getLiteLLMUserInfo(litellmUserId);
  if (info.spendUsd === null) return null;
  return Math.max(0, Math.trunc(info.spendUsd * 100));
};

export const getLiteLLMVirtualKeyInfo = async (virtualKey: string): Promise<LiteLLMVirtualKeyInfo> => {
  const token = virtualKey.trim();
  if (!token) {
    throw new Error('LiteLLM virtual key is required');
  }

  let parsed: unknown;

  try {
    parsed = await requestJson('GET', '/key/info', undefined, token);
  } catch (error: unknown) {
    if (!shouldFallbackToPost(error)) throw error;
    parsed = await requestJson('POST', '/key/info', {}, token);
  }

  const payload = maybeNestedRecord(parsed, ['info', 'data', 'key_info']);
  if (!payload) {
    throw new Error('LiteLLM /key/info returned invalid payload');
  }

  return {
    spendUsd: readNumber(payload, ['spend', 'spend_usd', 'total_spend', 'current_spend']) ?? 0,
    maxBudgetUsd: readNumber(payload, ['max_budget', 'budget']),
    budgetDuration: readString(payload, ['budget_duration']),
    rpmLimit: readNumber(payload, ['rpm_limit']),
    tpmLimit: readNumber(payload, ['tpm_limit']),
    keyAlias: readString(payload, ['key_alias', 'key_name']),
    userId: readString(payload, ['user_id']),
    raw: parsed
  };
};
