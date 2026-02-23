import type { UserRecord } from '@pin-ai/shared-types';

declare global {
  namespace Express {
    interface Request {
      gatewayUser?: UserRecord;
    }
  }
}

export {};
