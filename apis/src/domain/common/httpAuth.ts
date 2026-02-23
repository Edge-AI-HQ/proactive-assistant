import type { Request, Response, NextFunction } from 'express';
import { config } from './config.js';

const readToken = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0].trim();
  return '';
};

export const requireApiAuth = (req: Request, res: Response, next: NextFunction): void => {
  const expected = config.apiAuthToken.trim();
  if (!expected) {
    next();
    return;
  }

  const provided = readToken(req.headers['x-api-key']);
  if (!provided || provided !== expected) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
};
