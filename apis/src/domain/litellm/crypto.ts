import crypto from 'node:crypto';
import { getLiteLLMRuntime } from './runtime.js';

const config = new Proxy({} as { litellm: ReturnType<typeof getLiteLLMRuntime>['config']['litellm'] }, {
  get: (_target, prop) => getLiteLLMRuntime().config[prop as keyof ReturnType<typeof getLiteLLMRuntime>['config']]
});

const VERSION = 'v1';

const deriveSecretKey = (): Buffer => {
  const secret = config.litellm.keyEncryptionSecret.trim();
  if (!secret) {
    throw new Error('LITELLM_KEY_ENCRYPTION_SECRET is required for LiteLLM key encryption');
  }

  return crypto.createHash('sha256').update(secret, 'utf8').digest();
};

export const encryptLiteLLMKey = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('Cannot encrypt an empty LiteLLM key');
  }

  const key = deriveSecretKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(trimmed, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${VERSION}.${iv.toString('base64')}.${encrypted.toString('base64')}.${tag.toString('base64')}`;
};

export const decryptLiteLLMKey = (payload: string): string => {
  const segments = payload.split('.');
  if (segments.length !== 4 || segments[0] !== VERSION) {
    throw new Error('Unsupported encrypted LiteLLM key format');
  }

  const ivPart = segments[1];
  const encryptedPart = segments[2];
  const tagPart = segments[3];
  if (!ivPart || !encryptedPart || !tagPart) {
    throw new Error('Encrypted LiteLLM key is malformed');
  }
  const iv = Buffer.from(ivPart, 'base64');
  const encrypted = Buffer.from(encryptedPart, 'base64');
  const tag = Buffer.from(tagPart, 'base64');

  const key = deriveSecretKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

  const result = decrypted.toString('utf8').trim();
  if (!result) {
    throw new Error('Decrypted LiteLLM key is empty');
  }
  return result;
};
