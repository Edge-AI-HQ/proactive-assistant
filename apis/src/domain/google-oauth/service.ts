import fs from 'node:fs';
import path from 'node:path';
import Docker from 'dockerode';
import { decryptText, encryptText } from './crypto.js';
import { config } from '../common/config.js';
import { setAssistantRuntimeMetadataKey } from '../common/db/index.js';
import { buildGoogleConnectedMessage } from '../telegram-bot/startPayload.js';
import { buildMiniGoogleReturnUrl } from './miniapp.js';
import { resolveGoogleOAuthClientSecretPath } from './client_secret_file.js';
import {
  buildGoogleWorkspaceAuthorizedUserCredential,
  encodeGoogleWorkspaceAuthorizedUserCredential,
  GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE,
  GOOGLE_WORKSPACE_CLI_DEFAULT_CREDENTIALS_FILE,
  PINAI_GOOGLE_CREDENTIALS_B64_ENV,
  GOOGLE_CREDENTIALS_RUNTIME_METADATA_KEY,
} from '../container/providers/shared/google_workspace_credentials.js';
import { getMachine, updateMachine } from '../container/providers/fly/fly_client.js';
import {
  consumeOAuthState,
  createOAuthState,
  deleteGoogleCredentialByTelegramId,
  extractGoogleConnectedEmail,
  findLatestAssistantRuntimeByTelegramId,
  findUserIdentityByTelegramId,
  getGoogleCredentialByTelegramId,
  hasGoogleCredentialByTelegramId,
  saveGoogleCredential,
} from './repository.js';
import { listAssistantsByOwnerId } from '../claw-assistant/usecases.js';
import { ensureGatewayAssistantReady } from '../gateway/assistant_warmup.js';

const GOOGLE_AUTH_BASE = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';
const DEFAULT_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
].join(' ');

type GoogleClientSecretFile = {
  web?: {
    client_id?: string;
    client_secret?: string;
    redirect_uris?: string[];
  };
  installed?: {
    client_id?: string;
    client_secret?: string;
    redirect_uris?: string[];
  };
};

type OAuthClientConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

let oauthClientCache:
  | {
      secretPath: string;
      explicitRedirect: string;
      publicBaseUrl: string;
      value: OAuthClientConfig;
    }
  | null = null;

export function sanitizeGoogleTokenPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'access_token' || key === 'refresh_token' || key === 'id_token') continue;
    sanitized[key] = value;
  }
  return sanitized;
}

export function resetGoogleOAuthClientCacheForTest(): void {
  oauthClientCache = null;
}

export function resolveGoogleOAuthClientForTest(): OAuthClientConfig {
  return resolveOAuthClient();
}

const resolveOAuthClient = (): { clientId: string; clientSecret: string; redirectUri: string } => {
  const secretPath = resolveGoogleOAuthClientSecretPath();
  const explicitRedirect = process.env.GOOGLE_OAUTH_REDIRECT_URI?.trim() || '';
  const publicBaseUrl = config.publicBaseUrl.replace(/\/+$/, '');
  if (
    oauthClientCache &&
    oauthClientCache.secretPath === secretPath &&
    oauthClientCache.explicitRedirect === explicitRedirect &&
    oauthClientCache.publicBaseUrl === publicBaseUrl
  ) {
    return oauthClientCache.value;
  }

  const raw = fs.readFileSync(secretPath, 'utf8');
  const parsed = JSON.parse(raw) as GoogleClientSecretFile;
  const node = parsed.web || parsed.installed;
  const clientId = node?.client_id?.trim() || '';
  const clientSecret = node?.client_secret?.trim() || '';

  const defaultRedirect = `${publicBaseUrl}/mini/google/callback`;
  const redirectUri = explicitRedirect || defaultRedirect || node?.redirect_uris?.[0]?.trim() || '';

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('Invalid Google OAuth client_secret.json or missing GOOGLE_OAUTH_REDIRECT_URI');
  }

  const value = { clientId, clientSecret, redirectUri };
  oauthClientCache = {
    secretPath,
    explicitRedirect,
    publicBaseUrl,
    value,
  };
  return value;
};

const normalizeTelegramUserId = (value: unknown): number => {
  const raw = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!/^\d+$/.test(raw)) throw new Error('telegram_user_id is required');
  const n = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('telegram_user_id is invalid');
  return n;
};

const buildDockerContainerName = (runtimeRef: string | null): string | null => {
  const ref = (runtimeRef || '').trim();
  if (!ref) return null;
  if (ref.startsWith('docker:')) return ref.slice('docker:'.length);
  if (ref.startsWith('fly:')) return null;
  return ref;
};

const parseFlyMachineId = (runtimeRef: string | null): string | null => {
  const ref = (runtimeRef || '').trim();
  if (!ref.startsWith('fly:')) return null;
  const payload = ref.slice('fly:'.length);
  const [machineId] = payload.split('|', 2);
  return machineId?.trim() || null;
};

const resolveDockerContainerName = async (
  docker: Docker,
  telegramUserId: number,
  runtimeRef: string | null,
): Promise<string | null> => {
  const candidates = [buildDockerContainerName(runtimeRef), `assistant-${telegramUserId}`].filter(
    (v): v is string => Boolean(v && v.trim()),
  );

  for (const name of [...new Set(candidates)]) {
    try {
      await docker.getContainer(name).inspect();
      return name;
    } catch {
      // try next candidate
    }
  }
  return null;
};

const isoFromExpiresIn = (expiresIn: unknown): string | null => {
  const seconds = Number(expiresIn);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(Date.now() + seconds * 1000).toISOString();
};

const resolveGoogleCredentialPaths = (): {
  targetFile: string;
  gwsDefaultFile: string;
} => {
  const targetFile =
    process.env.GOOGLE_OAUTH_CONTAINER_FILE?.trim() ||
    GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE;
  return {
    targetFile,
    gwsDefaultFile: GOOGLE_WORKSPACE_CLI_DEFAULT_CREDENTIALS_FILE,
  };
};

const buildGoogleWorkspaceCredentialContent = async (
  telegramUserId: number,
): Promise<{
  content: ReturnType<typeof buildGoogleWorkspaceAuthorizedUserCredential>;
  encoded: string;
}> => {
  const cred = await getGoogleCredentialByTelegramId(telegramUserId);
  if (!cred) {
    throw new Error('No Google credential found for this user');
  }

  const { clientId, clientSecret } = resolveOAuthClient();
  const refreshToken = cred.refresh_token_enc ? decryptText(cred.refresh_token_enc) : '';
  if (!refreshToken) {
    throw new Error('Missing refresh token for gws credentials');
  }

  const content = buildGoogleWorkspaceAuthorizedUserCredential({
    clientId,
    clientSecret,
    refreshToken,
  });
  return {
    content,
    encoded: encodeGoogleWorkspaceAuthorizedUserCredential(content),
  };
};

const executeContainerShell = async (
  container: Docker.Container,
  command: string,
  stdin?: string,
): Promise<void> => {
  const exec = await container.exec({
    AttachStdin: Boolean(stdin),
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    Cmd: ['sh', '-lc', command],
  });
  const stream = await exec.start({ hijack: true, stdin: Boolean(stdin) });

  await new Promise<void>((resolve, reject) => {
    stream.on('error', reject);
    stream.on('end', resolve);
    if (stdin) {
      stream.end(stdin);
      return;
    }
    stream.end();
  });

  const inspect = await exec.inspect();
  if (inspect.ExitCode !== 0) {
    throw new Error(`docker exec failed with exit code ${inspect.ExitCode}`);
  }
};

const sendGoogleConnectedBotMessage = async (
  telegramUserId: number,
  email: string | null,
  syncedToContainer: boolean,
): Promise<void> => {
  const botToken = config.telegram.token.trim();
  if (!botToken) return;
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: telegramUserId,
      text: buildGoogleConnectedMessage(email, syncedToContainer),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`telegram sendMessage failed: ${response.status} ${body}`);
  }
};

export const parseTelegramUserId = normalizeTelegramUserId;

export const getGoogleConnectionStatus = async (telegramUserId: number): Promise<{
  connected: boolean;
  scopes: string;
  updatedAt: string;
  email: string | null;
}> => {
  const row = await getGoogleCredentialByTelegramId(telegramUserId);
  if (!row) return { connected: false, scopes: '', updatedAt: '', email: null };
  return {
    connected: Boolean(row.refresh_token_enc || row.access_token_enc),
    scopes: row.scope || '',
    updatedAt: row.updated_at,
    email: extractGoogleConnectedEmail(row),
  };
};

export const hasGoogleOAuthConnection = hasGoogleCredentialByTelegramId;

export const buildGoogleAuthStartUrl = async (telegramUserId: number, nextPath?: string): Promise<string> => {
  const { clientId, redirectUri } = resolveOAuthClient();
  const state = await createOAuthState({
    telegramUserId,
    nextPath: nextPath?.trim() || buildMiniGoogleReturnUrl('/mini', { status: 'connected' }),
  });

  const url = new URL(GOOGLE_AUTH_BASE);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', process.env.GOOGLE_OAUTH_SCOPES?.trim() || DEFAULT_SCOPES);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', state);
  return url.toString();
};

export const handleGoogleOAuthCallback = async (query: {
  code: string | undefined;
  state: string | undefined;
  error: string | undefined;
}): Promise<{
  nextPath: string;
  message: string;
  telegramUserId: number;
  email: string | null;
  botUsername: string | null;
}> => {
  if (query.error) throw new Error(`Google OAuth rejected: ${query.error}`);
  const code = (query.code || '').trim();
  const state = (query.state || '').trim();
  if (!code || !state) throw new Error('Missing code/state from callback');

  const stateRow = await consumeOAuthState(state);
  if (!stateRow) throw new Error('OAuth state invalid or expired');

  const user = await findUserIdentityByTelegramId(stateRow.telegramUserId);
  if (!user) {
    throw new Error(`Telegram user ${stateRow.telegramUserId} not found in users table`);
  }

  const { clientId, clientSecret, redirectUri } = resolveOAuthClient();
  const tokenResp = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }),
  });

  const payload = (await tokenResp.json()) as Record<string, unknown>;
  if (!tokenResp.ok) {
    throw new Error(`Token exchange failed: ${JSON.stringify(payload)}`);
  }

  const accessToken = typeof payload.access_token === 'string' ? payload.access_token : null;
  const refreshToken = typeof payload.refresh_token === 'string' ? payload.refresh_token : null;
  const idToken = typeof payload.id_token === 'string' ? payload.id_token : null;
  const scope = typeof payload.scope === 'string' ? payload.scope : null;
  const tokenType = typeof payload.token_type === 'string' ? payload.token_type : null;
  const expiryAt = isoFromExpiresIn(payload.expires_in);
  let email: string | null = null;

  if (accessToken) {
    const userInfoResp = await fetch(GOOGLE_USERINFO_ENDPOINT, {
      headers: { authorization: `Bearer ${accessToken}` },
    }).catch(() => null);
    if (userInfoResp?.ok) {
      const userInfo = (await userInfoResp.json()) as Record<string, unknown>;
      email = typeof userInfo.email === 'string' ? userInfo.email.trim() || null : null;
      payload.email = email;
      if (typeof userInfo.name === 'string') payload.name = userInfo.name;
      if (typeof userInfo.picture === 'string') payload.picture = userInfo.picture;
    }
  }

  const safePayload = sanitizeGoogleTokenPayload(payload);

  await saveGoogleCredential({
    userId: user.id,
    telegramUserId: stateRow.telegramUserId,
    accessTokenEnc: accessToken ? encryptText(accessToken) : null,
    refreshTokenEnc: refreshToken ? encryptText(refreshToken) : null,
    idTokenEnc: idToken ? encryptText(idToken) : null,
    tokenType,
    scope,
    expiryAt,
    rawPayload: safePayload,
  });

  const syncResult = await syncGoogleCredentialAfterOAuth(stateRow.telegramUserId);
  if (!syncResult.synced) {
    console.warn(
      `[google-oauth] credential sync incomplete for tg=${stateRow.telegramUserId}: ${syncResult.error || 'unknown error'}`,
    );
  }

  await sendGoogleConnectedBotMessage(stateRow.telegramUserId, email, syncResult.synced).catch((error) => {
    console.warn('[google-oauth] bot-confirmation skipped:', error);
  });

  return {
    nextPath: stateRow.nextPath,
    telegramUserId: stateRow.telegramUserId,
    message: 'Google OAuth connected and token stored.',
    email,
    botUsername: config.telegram.botUsername || null,
  };
};

const waitForAssistantReadyAfterGoogleSync = async (
  telegramUserId: number,
): Promise<void> => {
  const assistants = await listAssistantsByOwnerId(telegramUserId);
  const assistant = assistants[0];
  if (!assistant) return;
  await ensureGatewayAssistantReady(assistant);
};

const persistGoogleCredentialRuntimeMetadata = async (
  telegramUserId: number,
  googleCredentialsB64: string,
): Promise<void> => {
  const assistants = await listAssistantsByOwnerId(telegramUserId);
  const assistant = assistants[0];
  if (!assistant) return;
  await setAssistantRuntimeMetadataKey(
    assistant.id,
    GOOGLE_CREDENTIALS_RUNTIME_METADATA_KEY,
    googleCredentialsB64,
  );
};

const clearGoogleCredentialRuntimeMetadata = async (
  telegramUserId: number,
): Promise<void> => {
  const assistants = await listAssistantsByOwnerId(telegramUserId);
  const assistant = assistants[0];
  if (!assistant) return;
  await setAssistantRuntimeMetadataKey(
    assistant.id,
    GOOGLE_CREDENTIALS_RUNTIME_METADATA_KEY,
    "",
  );
};

type SyncGoogleCredentialDeps = {
  ensureReady: (telegramUserId: number) => Promise<void>;
  syncCredential: (telegramUserId: number) => Promise<{ message: string }>;
  sleep: (ms: number) => Promise<void>;
  maxAttempts: number;
};

type SyncGoogleCredentialResult = {
  synced: boolean;
  attempts: number;
  error?: string;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const syncGoogleCredentialAfterOAuth = async (
  telegramUserId: number,
  overrides?: Partial<SyncGoogleCredentialDeps>,
): Promise<SyncGoogleCredentialResult> => {
  const deps: SyncGoogleCredentialDeps = {
    ensureReady: waitForAssistantReadyAfterGoogleSync,
    syncCredential: syncCredentialToContainer,
    sleep,
    maxAttempts: 3,
    ...overrides,
  };

  let lastError: unknown = null;

  for (let attempt = 1; attempt <= deps.maxAttempts; attempt += 1) {
    try {
      await deps.ensureReady(telegramUserId);
      await deps.syncCredential(telegramUserId);
      await deps.ensureReady(telegramUserId);
      return { synced: true, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt < deps.maxAttempts) {
        await deps.sleep(Math.min(2000, attempt * 500));
      }
    }
  }

  return {
    synced: false,
    attempts: deps.maxAttempts,
    error: lastError instanceof Error ? lastError.message : String(lastError || 'unknown'),
  };
};

export const syncGoogleCredentialAfterOAuthForTest = (
  telegramUserId: number,
  overrides?: Partial<SyncGoogleCredentialDeps>,
): Promise<SyncGoogleCredentialResult> =>
  syncGoogleCredentialAfterOAuth(telegramUserId, overrides);

export const disconnectGoogleOAuth = async (telegramUserId: number): Promise<void> => {
  await deleteGoogleCredentialByTelegramId(telegramUserId);
  await clearGoogleCredentialRuntimeMetadata(telegramUserId).catch((error) => {
    console.warn('[google-oauth] clear-runtime-metadata skipped:', error);
  });
  await removeGoogleCredentialFromContainer(telegramUserId).catch((error) => {
    console.warn('[google-oauth] remove-from-container skipped:', error);
  });
};

export const removeGoogleCredentialFromContainer = async (
  telegramUserId: number,
): Promise<{ message: string }> => {
  const runtime = await findLatestAssistantRuntimeByTelegramId(telegramUserId);
  const runtimeProvider = (runtime?.runtime_provider || '').toLowerCase();

  if (runtimeProvider === 'fly') {
    const machineId = parseFlyMachineId(runtime?.runtime_ref || null);
    if (!machineId) {
      return { message: 'No fly machine found; only database credential was removed' };
    }

    const machine = await getMachine(machineId);
    if (!machine.config) {
      throw new Error(`Fly machine ${machineId} has no config`);
    }

    const nextEnv = {
      ...(machine.config.env || {}),
      [PINAI_GOOGLE_CREDENTIALS_B64_ENV]: '',
    };
    await updateMachine(machineId, {
      ...(machine.name ? { name: machine.name } : {}),
      config: {
        ...machine.config,
        env: nextEnv,
      },
    });
    return { message: `Credential removed from fly machine ${machineId}` };
  }

  const docker = new Docker();
  const containerName = await resolveDockerContainerName(
    docker,
    telegramUserId,
    runtime?.runtime_ref || null,
  );
  if (!containerName) {
    return { message: 'No container found; only database credential was removed' };
  }
  const { targetFile, gwsDefaultFile } = resolveGoogleCredentialPaths();
  const container = docker.getContainer(containerName);
  await executeContainerShell(
    container,
    `rm -f ${targetFile} ${gwsDefaultFile}`,
  );
  return { message: `Credential removed from ${containerName}` };
};

export const syncCredentialToContainer = async (telegramUserId: number): Promise<{ message: string }> => {
  const runtime = await findLatestAssistantRuntimeByTelegramId(telegramUserId);
  const runtimeProvider = (runtime?.runtime_provider || '').toLowerCase();
  const { content, encoded } = await buildGoogleWorkspaceCredentialContent(telegramUserId);
  await persistGoogleCredentialRuntimeMetadata(telegramUserId, encoded).catch((error) => {
    console.warn('[google-oauth] persist-runtime-metadata skipped:', error);
  });

  if (runtimeProvider === 'fly') {
    const machineId = parseFlyMachineId(runtime?.runtime_ref || null);
    if (!machineId) {
      throw new Error('No fly runtime_ref found for this user');
    }

    const machine = await getMachine(machineId);
    if (!machine.config) {
      throw new Error(`Fly machine ${machineId} has no config`);
    }

    const nextEnv = {
      ...(machine.config.env || {}),
      GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE,
      [PINAI_GOOGLE_CREDENTIALS_B64_ENV]: encoded,
    };
    await updateMachine(machineId, {
      ...(machine.name ? { name: machine.name } : {}),
      config: {
        ...machine.config,
        env: nextEnv,
      },
    });
    return { message: `Credential synced to fly machine ${machineId}:${GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE}` };
  }

  const docker = new Docker();
  const containerName = await resolveDockerContainerName(docker, telegramUserId, runtime?.runtime_ref || null);
  if (!containerName) {
    throw new Error('No docker runtime_ref found for this user');
  }
  const { targetFile, gwsDefaultFile } = resolveGoogleCredentialPaths();
  const targetDir = path.posix.dirname(targetFile);
  const gwsDefaultDir = path.posix.dirname(gwsDefaultFile);
  const container = docker.getContainer(containerName);
  await executeContainerShell(
    container,
    `mkdir -p ${targetDir} ${gwsDefaultDir} && cat > ${targetFile} && cp ${targetFile} ${gwsDefaultFile}`,
    `${JSON.stringify(content, null, 2)}\n`,
  );

  return { message: `Credential synced to ${containerName}:${targetFile}` };
};
