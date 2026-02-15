export interface UserRecord {
  id: number;
  telegram_user_id: number;
  telegram_username: string | null;
  google_email: string;
  google_id: string;
  container_id: string;
  container_port: number;
  container_status: string;
  gateway_token: string;
  created_at: string;
  last_active_at: string;
}

export interface OauthSessionRecord {
  id: number;
  telegram_user_id: number;
  telegram_username: string | null;
  state_token: string;
  created_at: string;
  expires_at: string;
}

export interface GatewayOauthSessionRecord {
  id: number;
  telegram_user_id: number;
  state_token: string;
  next_path: string;
  created_at: string;
  expires_at: string;
}

export interface GatewaySessionRecord {
  id: number;
  telegram_user_id: number;
  session_token: string;
  created_at: string;
  expires_at: string;
}

export interface MessageLogRecord {
  id: number;
  telegram_user_id: number;
  direction: string | null;
  message_text: string | null;
  created_at: string;
}

export interface AdminUserRecord {
  id: number;
  username: string;
  password_hash: string;
  email: string | null;
  created_at: string;
}

export interface AdminSessionRecord {
  id: number;
  admin_id: number;
  session_token: string;
  expires_at: string;
}

export interface AdminSessionView extends AdminSessionRecord {
  admin_username: string;
}

export type AuthAllowlistKind = 'domain' | 'email';

export interface AuthAllowlistRecord {
  id: number;
  kind: AuthAllowlistKind;
  value: string;
  created_at: string;
}

export interface CreateUserInput {
  telegram_user_id: number;
  telegram_username?: string | null;
  google_email: string;
  google_id: string;
  container_id: string;
  container_port: number;
  container_status?: string;
  gateway_token: string;
}

export type UserMutableFields = Partial<
  Pick<
    UserRecord,
    | 'telegram_username'
    | 'google_email'
    | 'google_id'
    | 'container_id'
    | 'container_port'
    | 'container_status'
    | 'gateway_token'
  >
>;

export interface Config {
  nodeEnv: string;
  port: number;
  publicBaseUrl: string;
  apiDomain: string;
  databasePath: string;
  telegram: {
    token: string;
    webhookSecret: string;
  };
  google: {
    clientId: string;
    clientSecret: string;
    callbackUrl: string;
  };
  auth: {
    allowedDomains: string[];
    allowedEmails: string[];
  };
  openclaw: {
    image: string;
    gatewayPort: number;
    httpPath: string;
    wsPath: string;
    apiKey: string;
    braveApiKey: string;
  };
  anthropicApiKey: string;
  openaiApiKey: string;
  elevenLabs: {
    apiKey: string;
    baseUrl: string;
    sttModel: string;
  };
  admin: {
    username: string;
    passwordHash: string;
    sessionSecret: string;
    sessionTtlHours: number;
  };
  container: {
    runtime: 'docker' | 'fly';
    portStart: number;
    portEnd: number;
    memoryMb: number;
    cpuShares: number;
  };
  fly: {
    apiBaseUrl: string;
    apiToken: string;
    appName: string;
    region: string;
    volumeSizeGb: number;
    volumeNamePrefix: string;
    machineCpus: number;
    gatewayProbe: boolean;
    gatewayProbeTimeoutMs: number;
  };
  featureFlags: {
    allowMissingSecrets: boolean;
  };
}

export type RequiredSecret = [name: string, value: string];
