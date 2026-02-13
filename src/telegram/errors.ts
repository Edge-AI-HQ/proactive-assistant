import {
  OPENCLAW_TIMEOUT_ERROR_RE,
  OPENCLAW_TRANSIENT_ERROR_RE,
  TELEGRAM_DELIVERY_ERROR_RE
} from './constants.js';
import { isRecoverableTelegramNetworkError } from './networkErrors.js';

export const toError = (error: unknown): Error => {
  if (error instanceof Error) return error;
  return new Error(String(error));
};

export const isOpenClawTimeoutError = (error: Error): boolean => OPENCLAW_TIMEOUT_ERROR_RE.test(error.message);

export const isOpenClawTransientError = (error: Error): boolean => OPENCLAW_TRANSIENT_ERROR_RE.test(error.message);

export const isOpenClawRecoverableError = (error: Error): boolean => {
  return (
    isOpenClawTimeoutError(error) ||
    isOpenClawTransientError(error) ||
    isRecoverableTelegramNetworkError(error, { context: 'send', allowMessageMatch: true })
  );
};

export const isTelegramDeliveryError = (error: Error): boolean => TELEGRAM_DELIVERY_ERROR_RE.test(error.message);
