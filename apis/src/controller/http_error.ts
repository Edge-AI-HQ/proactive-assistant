import type { Response } from 'express';
import {
  DomainError,
  isDomainError,
  type DomainErrorCode,
} from '../domain/common/errors.js';

export interface HttpErrorBody {
  error: { code: DomainErrorCode; message: string };
}

const buildBody = (code: DomainErrorCode, message: string): HttpErrorBody => ({
  error: { code, message },
});

/**
 * Map a thrown value to the standard `{ error: { code, message } }` JSON
 * response. DomainError is passed through (its message is business-facing
 * by contract). Unknown errors collapse to 500 INTERNAL with `fallback` —
 * never the raw Error.message — so internal failures don't leak details
 * (DB driver text, file paths, library internals) to API clients.
 *
 * Caller is responsible for logging the original error before calling this.
 */
export const sendError = (
  res: Response,
  err: unknown,
  fallback = 'Internal server error',
): void => {
  if (isDomainError(err)) {
    res.status(err.status).json(buildBody(err.code, err.message));
    return;
  }
  res.status(500).json(buildBody('INTERNAL', fallback));
};

/**
 * Send a DomainError-shaped response without throwing first. Useful for
 * synchronous validation paths in handlers (e.g. missing required fields,
 * unauthorized).
 */
export const sendDomainError = (
  res: Response,
  code: DomainErrorCode,
  message: string,
  status?: number,
): void => {
  const error = new DomainError(code, message, status);
  res.status(error.status).json(buildBody(error.code, error.message));
};
