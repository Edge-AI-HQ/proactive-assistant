import type { UserRecord } from '../types/index.js';

declare global {
  namespace Express {
    interface Request {
      gatewayUser?: UserRecord;
    }
  }
}

export {};
