export interface PinEnvelopeMeta {
  domain: string;
  command: string;
  requestId: string;
  timestamp: string;
}

export interface PinErrorShape {
  type: string;
  code: string;
  message: string;
  hint?: string;
}

export interface PinNotice {
  message: string;
  hint?: string;
}

export interface PinEnvelope<T> {
  ok: boolean;
  data: T | null;
  meta: PinEnvelopeMeta;
  error: PinErrorShape | null;
  _notice: Record<string, PinNotice> | null;
}

const nextRequestId = (): string =>
  `req_${Math.random().toString(36).slice(2, 10)}`;

export const okEnvelope = <T>(
  domain: string,
  command: string,
  data: T,
  notice?: Record<string, PinNotice>,
): PinEnvelope<T> => ({
  ok: true,
  data,
  meta: {
    domain,
    command,
    requestId: nextRequestId(),
    timestamp: new Date().toISOString(),
  },
  error: null,
  _notice: notice ?? null,
});

export const errorEnvelope = (
  domain: string,
  command: string,
  type: string,
  code: string,
  message: string,
  hint?: string,
): PinEnvelope<null> => ({
  ok: false,
  data: null,
  meta: {
    domain,
    command,
    requestId: nextRequestId(),
    timestamp: new Date().toISOString(),
  },
  error: {
    type,
    code,
    message,
    ...(hint ? { hint } : {}),
  },
  _notice: null,
});
