import { config } from "../common/config.js";
import type { AssistantRecord, UserRecord } from "../../types.js";

export class BackendApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "BackendApiError";
    this.status = status;
  }
}

const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, "");

const requestTimeoutMs = (): number =>
  Math.max(1000, config.payment.telegramBotRequestTimeoutMs);

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> => {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const baseUrl = (): string => {
  // Bot now calls the same API server (itself), use localhost
  return 'http://127.0.0.1:' + config.port;
};

const buildHeaders = (
  withJsonContentType = true,
  apiKeyOverride?: string,
): Record<string, string> => {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (withJsonContentType) {
    headers["Content-Type"] = "application/json";
  }

  const token = (apiKeyOverride ?? config.apiAuthToken).trim();
  if (token) {
    headers["x-api-key"] = token;
  }

  return headers;
};

const parseJsonSafe = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
};

const extractErrorMessage = (payload: unknown, fallback: string): string => {
  if (payload && typeof payload === "object") {
    const message = (payload as Record<string, unknown>).error;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
};

const requestJson = async <T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: Record<string, unknown>,
  options?: { apiKey?: string },
): Promise<T> => {
  const requestInit: RequestInit = {
    method,
    headers: buildHeaders(
      method !== "GET" && method !== "DELETE",
      options?.apiKey,
    ),
  };
  if (method === "POST") {
    requestInit.body = JSON.stringify(body ?? {});
  }

  const timeoutMs = requestTimeoutMs();
  const response = await withTimeout(
    fetch(`${baseUrl()}${path}`, requestInit),
    timeoutMs,
    `Backend API request timed out after ${timeoutMs}ms`,
  );

  const payload = await parseJsonSafe(response);
  if (!response.ok) {
    throw new BackendApiError(
      response.status,
      extractErrorMessage(payload, `HTTP ${response.status}`),
    );
  }

  return payload as T;
};

export interface ProvisionAssistantInput {
  ownerTelegramUserId: number;
  ownerTelegramUsername: string | null;
  assistantBotId: number;
  assistantBotToken: string;
  assistantBotUsername: string;
}

export interface ProvisionAssistantResponse {
  assistant: AssistantRecord;
  ready: boolean;
}

export interface GatewaySessionResponse {
  session_token: string;
  expires_at: string;
}

export interface PaymentSessionResponse {
  token: string;
  expires_at: string;
  subscribe_url: string;
}

export const ensureTelegramUserViaApi = async (
  telegramUserId: number,
  telegramUsername?: string | null,
): Promise<UserRecord> => {
  const response = await requestJson<{ user: UserRecord }>(
    "POST",
    "/api/user/ensure",
    {
      provider: "telegram",
      provider_user_id: telegramUserId,
      provider_username: telegramUsername ?? null,
    },
  );
  return response.user;
};

export const provisionAssistantViaApi = async (
  input: ProvisionAssistantInput,
): Promise<ProvisionAssistantResponse> => {
  return requestJson<ProvisionAssistantResponse>(
    "POST",
    "/api/claw-assistant/provision",
    {
      owner_telegram_user_id: input.ownerTelegramUserId,
      owner_telegram_username: input.ownerTelegramUsername,
      assistant_bot_id: input.assistantBotId,
      assistant_bot_token: input.assistantBotToken,
      assistant_bot_username: input.assistantBotUsername,
    },
  );
};

export const createAssistantWithoutContainerViaApi = async (
  input: ProvisionAssistantInput,
): Promise<{ assistant: AssistantRecord }> => {
  return requestJson<{ assistant: AssistantRecord }>(
    "POST",
    "/api/claw-assistant/create-without-container",
    {
      owner_telegram_user_id: input.ownerTelegramUserId,
      owner_telegram_username: input.ownerTelegramUsername,
      assistant_bot_id: input.assistantBotId,
      assistant_bot_token: input.assistantBotToken,
      assistant_bot_username: input.assistantBotUsername,
    },
  );
};

export const listAssistantsByOwnerViaApi = async (
  ownerTelegramUserId: number,
): Promise<AssistantRecord[]> => {
  const response = await requestJson<{ assistants: AssistantRecord[] }>(
    "GET",
    `/api/claw-assistant/owner/${ownerTelegramUserId}`,
  );
  return response.assistants;
};

export const createGatewaySessionViaApi = async (
  telegramUserId: number,
  ttlHours: number,
): Promise<GatewaySessionResponse> => {
  return requestJson<GatewaySessionResponse>("POST", "/api/gateway/session", {
    telegram_user_id: telegramUserId,
    ttl_hours: ttlHours,
  });
};

export const createPaymentSessionViaApi = async (
  telegramUserId: number,
  telegramUsername: string | null | undefined,
): Promise<PaymentSessionResponse> => {
  return requestJson<PaymentSessionResponse>(
    "POST",
    "/api/payment/internal/payment-session",
    {
      telegram_user_id: String(telegramUserId),
      telegram_username: telegramUsername || null,
    },
  );
};

export const isPaymentEnabled = (): boolean =>
  Boolean(config.payment.stripeSecretKey.trim());

export const createPaymentSessionForUser = async (
  telegramUserId: number,
  telegramUsername: string | null | undefined,
): Promise<PaymentSessionResponse | null> => {
  if (!isPaymentEnabled()) return null;
  return createPaymentSessionViaApi(telegramUserId, telegramUsername);
};

export const cancelUserSubscription = async (
  telegramUserId: number,
): Promise<{
  ok: boolean;
  status: string;
  cancel_at_period_end: boolean;
  current_period_end: string;
}> => {
  return requestJson("POST", "/api/payment/cancel-subscription", {
    telegram_user_id: String(telegramUserId),
  });
};

export const deleteAssistantViaApi = async (
  assistantId: number,
): Promise<{ deleted: boolean }> => {
  return requestJson("DELETE", `/api/claw-assistant/${assistantId}`);
};
