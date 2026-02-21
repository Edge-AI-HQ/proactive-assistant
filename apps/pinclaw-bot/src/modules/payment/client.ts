import { config } from '../../config.js';

interface PaymentSessionResponse {
  token: string;
  expires_at: string;
  subscribe_url: string;
}

interface PaymentSessionApiResponse {
  token: string;
  expires_at: string;
  subscribe_url?: string;
}

const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

const requestTimeoutMs = (): number => Math.max(1000, config.payment.requestTimeoutMs);

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> => {
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

const validateResponse = (value: unknown): PaymentSessionApiResponse => {
  if (!value || typeof value !== 'object') {
    throw new Error('Payment service returned invalid payload');
  }

  const data = value as Record<string, unknown>;
  const token = typeof data.token === 'string' ? data.token.trim() : '';
  const expiresAt = typeof data.expires_at === 'string' ? data.expires_at.trim() : '';
  const subscribeUrl = typeof data.subscribe_url === 'string' ? data.subscribe_url.trim() : undefined;

  if (!token || !expiresAt) {
    throw new Error('Payment service payload missing token/expires_at');
  }

  const result: PaymentSessionApiResponse = {
    token,
    expires_at: expiresAt
  };

  if (subscribeUrl) {
    result.subscribe_url = subscribeUrl;
  }

  return result;
};

export const isPaymentEnabled = (): boolean => config.payment.enabled;

export const createPaymentSessionForUser = async (
  telegramUserId: number,
  telegramUsername: string | null | undefined
): Promise<PaymentSessionResponse | null> => {
  if (!isPaymentEnabled()) return null;

  const baseUrl = config.payment.baseUrl.trim();
  const apiKey = config.payment.internalApiKey.trim();
  if (!baseUrl || !apiKey) {
    throw new Error('Payment is enabled but PAYMENT_SERVICE_BASE_URL/PAYMENT_SERVICE_API_KEY is missing.');
  }

  const response = await withTimeout(
    fetch(`${baseUrl}/api/internal/payment-session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey
      },
      body: JSON.stringify({
        telegram_user_id: String(telegramUserId),
        telegram_username: telegramUsername || null
      })
    }),
    requestTimeoutMs(),
    `Payment service request timed out after ${requestTimeoutMs()}ms`
  );

  const payload = (await response.json()) as unknown;
  if (!response.ok) {
    const detail =
      payload && typeof payload === 'object' && typeof (payload as Record<string, unknown>).error === 'string'
        ? (payload as Record<string, unknown>).error
        : `HTTP ${response.status}`;
    throw new Error(`Payment service request failed: ${detail}`);
  }

  const session = validateResponse(payload);
  const subscribeUrl =
    session.subscribe_url?.trim() ||
    `${stripTrailingSlash(baseUrl)}/api/subscribe?token=${encodeURIComponent(session.token)}`;

  return {
    token: session.token,
    expires_at: session.expires_at,
    subscribe_url: subscribeUrl
  };
};
