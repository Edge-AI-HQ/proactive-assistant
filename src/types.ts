export interface UserRecord {
  id: number;
  telegram_user_id: number;
  telegram_username: string | null;
  container_id: string;
  container_port: number;
  container_status: string;
  gateway_token: string;
  created_at: string;
  last_active_at: string;
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

export interface CreateUserInput {
  telegram_user_id: number;
  telegram_username?: string | null;
  container_id: string;
  container_port: number;
  container_status?: string;
  gateway_token: string;
}

export type UserMutableFields = Partial<
  Pick<
    UserRecord,
    | 'telegram_username'
    | 'container_id'
    | 'container_port'
    | 'container_status'
    | 'gateway_token'
  >
>;

export interface TokenUsageLedgerInput {
  telegram_user_id: number;
  session_key: string;
  run_id: string;
  idempotency_key: string;
  provider?: string | null;
  model?: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  cost_usd: number;
}

export interface TokenUsageLedgerRecord {
  id: number;
  telegram_user_id: number;
  session_key: string;
  run_id: string;
  idempotency_key: string;
  provider: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  cost_usd: number;
  created_at: string;
}

export interface UserUsageTotalsRecord {
  telegram_user_id: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  updated_at: string;
}

export interface UserWithUsageRecord extends UserRecord {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
}

export interface UsageOverviewRecord {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
}

export interface Config {
  nodeEnv: string;
  port: number;
  publicBaseUrl: string;
  apiDomain: string;
  databasePath: string;
  telegram: {
    token: string;
    webhookSecret: string;
    botUsername: string;
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
