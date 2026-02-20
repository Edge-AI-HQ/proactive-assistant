import { getLiteLLMRuntime } from './runtime.js';

const config = new Proxy({} as { litellm: ReturnType<typeof getLiteLLMRuntime>['config']['litellm'] }, {
  get: (_target, prop) => getLiteLLMRuntime().config[prop as keyof ReturnType<typeof getLiteLLMRuntime>['config']]
});

type JsonRecord = Record<string, unknown>;

interface LiteLLMCreateUserInput {
  userId: string;
  userAlias: string;
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

const isRecord = (value: unknown): value is JsonRecord => typeof value === 'object' && value !== null;

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

const apiUrl = (path: string): string => `${config.litellm.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;

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

export const createLiteLLMUser = async (input: LiteLLMCreateUserInput): Promise<void> => {
  const body: JsonRecord = {
    user_id: input.userId,
    user_alias: input.userAlias
  };
  if (input.metadata && Object.keys(input.metadata).length > 0) {
    body.metadata = input.metadata;
  }

  try {
    await requestJson('POST', '/user/new', body);
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw error;
    const lower = error.message.toLowerCase();
    if (lower.includes('already') || lower.includes('exists') || lower.includes('duplicate')) return;
    throw error;
  }
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

export const getLiteLLMVirtualKeyInfo = async (virtualKey: string): Promise<LiteLLMVirtualKeyInfo> => {
  let parsed: unknown;

  try {
    parsed = await requestJson('GET', '/key/info', undefined, virtualKey);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '';
    const lower = message.toLowerCase();
    const shouldFallback =
      /\/key\/info failed \((404|405)\)/.test(message) ||
      lower.includes('method not allowed') ||
      lower.includes('not found');
    if (!shouldFallback) throw error;
    parsed = await requestJson('POST', '/key/info', {}, virtualKey);
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
