export interface PinEnvelopeMeta {
  domain: string;
  command: string;
  requestId: string;
  timestamp: string;
}

export interface PinErrorShape {
  code: string;
  message: string;
}

export interface PinEnvelope<T> {
  ok: boolean;
  data: T | null;
  meta: PinEnvelopeMeta;
  error: PinErrorShape | null;
}

const nextRequestId = (): string =>
  `req_${Math.random().toString(36).slice(2, 10)}`;

export const okEnvelope = <T>(
  domain: string,
  command: string,
  data: T,
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
});

export const errorEnvelope = (
  domain: string,
  command: string,
  code: string,
  message: string,
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
    code,
    message,
  },
});
