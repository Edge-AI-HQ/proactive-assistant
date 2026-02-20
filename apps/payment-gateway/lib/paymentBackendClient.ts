const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

const readPaymentBackendBaseUrl = (): string => {
  const baseUrl = stripTrailingSlash((process.env.PAYMENT_BACKEND_BASE_URL || '').trim());
  if (!baseUrl) {
    throw new Error('PAYMENT_BACKEND_BASE_URL is required');
  }
  return baseUrl;
};

const readInternalApiKey = (): string => {
  const key = (
    process.env.PAYMENT_BACKEND_API_KEY ||
    process.env.PAYMENT_GATEWAY_INTERNAL_API_KEY ||
    process.env.PINCLAW_INTERNAL_API_KEY ||
    ''
  ).trim();
  if (!key) {
    throw new Error('PAYMENT_BACKEND_API_KEY is required');
  }
  return key;
};

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  internal?: boolean;
}

const parsePayload = async (response: Response): Promise<unknown> => {
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('application/json')) {
    return response.json();
  }

  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
};

const request = async <T>(path: string, options: RequestOptions = {}): Promise<T> => {
  const headers: Record<string, string> = {
    Accept: 'application/json'
  };

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  if (options.internal) {
    headers['x-api-key'] = readInternalApiKey();
  }

  const response = await fetch(`${readPaymentBackendBaseUrl()}${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });

  const payload = (await parsePayload(response)) as Record<string, unknown>;
  if (!response.ok) {
    const detail = typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
    throw new Error(`Payment backend request failed: ${detail}`);
  }

  return payload as T;
};

export interface PaymentPlan {
  id: string;
  name: string;
  price: string;
  priceId: string;
  description: string;
  features: string[];
  popular: boolean;
}

export interface PaymentSessionView {
  token: string;
  telegram_user_id: string;
  telegram_username: string | null;
  used: boolean;
  expires_at: string;
}

export interface CheckoutResponse {
  url: string;
}

export interface SubscriptionResponse {
  subscription: unknown;
}

export const paymentBackendClient = {
  getPlans: () => request<{ plans: PaymentPlan[] }>('/api/plans'),
  createCheckout: (token: string, plan: string) =>
    request<CheckoutResponse>('/api/create-checkout', {
      method: 'POST',
      body: { token, plan }
    }),
  createPaymentSession: (telegramUserId: string, telegramUsername: string | null, ttlSeconds?: number) =>
    request<{ token: string; expires_at: string; subscribe_url: string }>('/api/internal/payment-session', {
      method: 'POST',
      internal: true,
      body: {
        telegram_user_id: telegramUserId,
        telegram_username: telegramUsername,
        ttl_seconds: ttlSeconds
      }
    }),
  validatePaymentSession: (token: string) =>
    request<PaymentSessionView>(`/api/internal/payment-session-validate?token=${encodeURIComponent(token)}`, {
      internal: true
    }),
  getSubscription: (telegramUserId: string) =>
    request<SubscriptionResponse>(`/api/internal/subscription?telegram_user_id=${encodeURIComponent(telegramUserId)}`, {
      internal: true
    }),
  health: () => request<Record<string, unknown>>('/api/health')
};
