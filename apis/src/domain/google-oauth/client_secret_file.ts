import fs from 'node:fs';
import path from 'node:path';

export const GOOGLE_OAUTH_CLIENT_SECRET_DEFAULT_FILE = '/app/data/google/client_secret.json';

export const resolveGoogleOAuthClientSecretPath = (): string => {
  const fromEnv = process.env.GOOGLE_OAUTH_CLIENT_SECRET_PATH?.trim();
  return fromEnv || GOOGLE_OAUTH_CLIENT_SECRET_DEFAULT_FILE;
};

export const materializeGoogleOAuthClientSecretFromEnv = (
  targetPath = resolveGoogleOAuthClientSecretPath(),
): string | null => {
  const encoded = process.env.GOOGLE_OAUTH_CLIENT_SECRET_JSON_B64?.trim();
  if (!encoded) return null;

  const decoded = Buffer.from(encoded, 'base64').toString('utf8').trim();
  if (!decoded) {
    throw new Error('GOOGLE_OAUTH_CLIENT_SECRET_JSON_B64 decoded to empty content');
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, `${decoded}\n`, { mode: 0o600 });
  return targetPath;
};
