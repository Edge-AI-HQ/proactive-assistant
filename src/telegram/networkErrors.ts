const RECOVERABLE_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_ABORTED',
  'ECONNABORTED',
  'ERR_NETWORK'
]);

const RECOVERABLE_ERROR_NAMES = new Set([
  'AbortError',
  'TimeoutError',
  'ConnectTimeoutError',
  'HeadersTimeoutError',
  'BodyTimeoutError'
]);

const RECOVERABLE_MESSAGE_SNIPPETS = [
  'fetch failed',
  'typeerror: fetch failed',
  'undici',
  'network error',
  'network request',
  'client network socket disconnected',
  'socket hang up',
  'getaddrinfo',
  'timeout',
  'timed out'
];

const normalizeCode = (code?: string): string => code?.trim().toUpperCase() ?? '';

const getErrorName = (err: unknown): string => {
  if (!err || typeof err !== 'object') return '';
  return 'name' in err ? String(err.name) : '';
};

const getErrorCode = (err: unknown): string | undefined => {
  if (!err || typeof err !== 'object') return undefined;

  const direct = (err as { code?: unknown }).code;
  if (typeof direct === 'string') return direct;
  if (typeof direct === 'number') return String(direct);

  const errno = (err as { errno?: unknown }).errno;
  if (typeof errno === 'string') return errno;
  if (typeof errno === 'number') return String(errno);

  return undefined;
};

const toErrorMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
};

const collectErrorCandidates = (err: unknown): unknown[] => {
  const queue: unknown[] = [err];
  const seen = new Set<unknown>();
  const candidates: unknown[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current == null || seen.has(current)) continue;

    seen.add(current);
    candidates.push(current);

    if (typeof current !== 'object') continue;

    const cause = (current as { cause?: unknown }).cause;
    if (cause && !seen.has(cause)) queue.push(cause);

    const reason = (current as { reason?: unknown }).reason;
    if (reason && !seen.has(reason)) queue.push(reason);

    const errors = (current as { errors?: unknown }).errors;
    if (Array.isArray(errors)) {
      for (const nested of errors) {
        if (nested && !seen.has(nested)) queue.push(nested);
      }
    }

    // Grammy HttpError usually wraps root cause in .error.
    if (getErrorName(current) === 'HttpError') {
      const wrappedError = (current as { error?: unknown }).error;
      if (wrappedError && !seen.has(wrappedError)) queue.push(wrappedError);
    }
  }

  return candidates;
};

export type TelegramNetworkErrorContext = 'polling' | 'send' | 'webhook' | 'unknown';

export const isRecoverableTelegramNetworkError = (
  err: unknown,
  options: { context?: TelegramNetworkErrorContext; allowMessageMatch?: boolean } = {}
): boolean => {
  if (!err) return false;

  const allowMessageMatch =
    typeof options.allowMessageMatch === 'boolean' ? options.allowMessageMatch : options.context !== 'send';

  for (const candidate of collectErrorCandidates(err)) {
    const code = normalizeCode(getErrorCode(candidate));
    if (code && RECOVERABLE_ERROR_CODES.has(code)) return true;

    const name = getErrorName(candidate);
    if (name && RECOVERABLE_ERROR_NAMES.has(name)) return true;

    if (allowMessageMatch) {
      const message = toErrorMessage(candidate).toLowerCase();
      if (message && RECOVERABLE_MESSAGE_SNIPPETS.some((snippet) => message.includes(snippet))) {
        return true;
      }
    }
  }

  return false;
};
