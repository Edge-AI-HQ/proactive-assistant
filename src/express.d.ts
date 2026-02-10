import type { AdminSessionView, UserRecord } from './types.js';

declare global {
  namespace Express {
    interface Request {
      gatewayUser?: UserRecord;
      adminSession?: AdminSessionView;
    }
  }
}

export {};
