export type DomainErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNAUTHORIZED'
  | 'UNAVAILABLE'
  | 'INTERNAL';

const defaultStatusByCode: Record<DomainErrorCode, number> = {
  INVALID_INPUT: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNAUTHORIZED: 401,
  UNAVAILABLE: 503,
  INTERNAL: 500
};

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly status: number;

  constructor(code: DomainErrorCode, message: string, status?: number, cause?: unknown) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status ?? defaultStatusByCode[code];
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

export const isDomainError = (value: unknown): value is DomainError => {
  return value instanceof DomainError;
};

export const domainErrorMessage = (value: unknown, fallback = 'Unknown error'): string => {
  if (value instanceof Error && value.message) return value.message;
  return fallback;
};
