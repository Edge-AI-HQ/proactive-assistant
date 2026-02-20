import { config } from '../../config.js';

interface PaymentSessionResponse {
  token: string;
  expires_at: string;
  subscribe_url: string;
}

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

const validateResponse = (value: unknown): PaymentSessionResponse => {
  if (!value || typeof value !== 'object') {
    throw new Error('Payment gateway returned invalid payload');
  }

  const data = value as Record<string, unknown>;
  const token = typeof data.token === 'string' ? data.token.trim() : '';
  const expiresAt = typeof data.expires_at === 'string' ? data.expires_at.trim() : '';
  const subscribeUrl = typeof data.subscribe_url === 'string' ? data.subscribe_url.trim() : '';

  if (!token || !expiresAt || !subscribeUrl) {
    throw new Error('Payment gateway payload missing token/expires_at/subscribe_url');
  }

  return {
    token,
    expires_at: expiresAt,
    subscribe_url: subscribeUrl
  };
};

export const isPaymentGatewayEnabled = (): boolean => config.payment.enabled;

export const createPaymentSessionForUser = async (
  telegramUserId: number,
  telegramUsername: string | null | undefined
): Promise<PaymentSessionResponse | null> => {
  if (!isPaymentGatewayEnabled()) return null;

  const baseUrl = config.payment.baseUrl.trim();
  const apiKey = config.payment.internalApiKey.trim();
  if (!baseUrl || !apiKey) {
    throw new Error('Payment gateway is enabled but PAYMENT_GATEWAY_BASE_URL or PAYMENT_GATEWAY_INTERNAL_API_KEY is missing.');
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
    `Payment gateway request timed out after ${requestTimeoutMs()}ms`
  );

  const payload = (await response.json()) as unknown;
  if (!response.ok) {
    const detail =
      payload && typeof payload === 'object' && typeof (payload as Record<string, unknown>).error === 'string'
        ? (payload as Record<string, unknown>).error
        : `HTTP ${response.status}`;
    throw new Error(`Payment gateway request failed: ${detail}`);
  }

  return validateResponse(payload);
};
