import crypto from 'node:crypto';

const ALGO = 'aes-256-gcm';

const resolveKey = (): Buffer => {
  const secret =
    process.env.GOOGLE_OAUTH_ENCRYPTION_KEY?.trim() ||
    process.env.API_INTERNAL_TOKEN?.trim() ||
    process.env.LITELLM_KEY_ENCRYPTION_SECRET?.trim() ||
    '';
  if (!secret) {
    throw new Error('Missing GOOGLE_OAUTH_ENCRYPTION_KEY/API_INTERNAL_TOKEN for Google OAuth encryption');
  }
  return crypto.createHash('sha256').update(secret).digest();
};

export const encryptText = (plainText: string): string => {
  const key = resolveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${encrypted.toString('base64url')}`;
};

export const decryptText = (cipherText: string): string => {
  const [version, ivB64, tagB64, payloadB64] = cipherText.split(':');
  if (version !== 'v1' || !ivB64 || !tagB64 || !payloadB64) {
    throw new Error('Invalid encrypted payload');
  }

  const key = resolveKey();
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payloadB64, 'base64url')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
};
