// Shared API config types. User/Assistant records have moved to their owning
// domain (proactive uses ProactiveUser; payment uses its own row types).

export interface OpenclawConfig {
  image: string;
  gatewayPort: number;
  braveApiKey: string;
}

export interface LiteLLMConfig {
  enabled: boolean;
  baseUrl: string;
  masterKey: string;
  requestTimeoutMs: number;
  syncIntervalMs: number;
  keyAliasPrefix: string;
  defaultBudgetUsd: number | null;
  defaultBudgetDuration: string;
  defaultRpmLimit: number | null;
  defaultTpmLimit: number | null;
  allowedModels: string[];
  openclawDefaultModel: string;
}

export interface ElevenLabsConfig {
  apiKey: string;
  baseUrl: string;
}

export interface SupabaseConfig {
  dbUrl: string;
}

export interface PaymentConfig {
  requestTimeoutMs: number;
  stripeSecretKey: string;
  stripeWebhookSecret: string;
  stripePriceIdBasic: string;
  stripePriceIdPro: string;
  stripePriceIdMax: string;
  publicBaseUrl: string;
  cronSecret: string;
}

export interface ContainerConfig {
  runtime: "docker" | "fly";
  portStart: number;
  portEnd: number;
  memoryMb: number;
  cpuShares: number;
  /** Idle time in ms before auto-suspending a container. 0 = disabled. */
  idleSuspendMs: number;
}

export interface FlyConfig {
  apiBaseUrl: string;
  apiToken: string;
  appName: string;
  assistantAppName: string;
  region: string;
  regionFallbacks: string[];
  volumeSizeGb: number;
  volumeNamePrefix: string;
  machineCpus: number;
  gatewayProbe: boolean;
  gatewayProbeTimeoutMs: number;
}

export interface FeatureFlagsConfig {
  allowMissingSecrets: boolean;
}

export interface Config {
  nodeEnv: string;
  port: number;
  publicBaseUrl: string;
  apiAuthToken: string;
  openclaw: OpenclawConfig;
  litellm: LiteLLMConfig;
  anthropicApiKey: string;
  openaiApiKey: string;
  elevenLabs: ElevenLabsConfig;
  supabase: SupabaseConfig;
  payment: PaymentConfig;
  container: ContainerConfig;
  fly: FlyConfig;
  featureFlags: FeatureFlagsConfig;
}

export type RequiredSecret = readonly [name: string, value: string];
