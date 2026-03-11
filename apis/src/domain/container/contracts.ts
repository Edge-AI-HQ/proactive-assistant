import type { AssistantRecord } from "./types.js";

// ---------------------------------------------------------------------------
// Gateway Target
// ---------------------------------------------------------------------------

export interface GatewayTarget {
  host: string;
  port: number;
  httpBaseUrl: string;
  wsBaseUrl: string;
  /**
   * Override Host header to send when proxying/probing this target.
   *
   * On Fly, connections to loopback-bound assistant machines arrive at
   * 127.0.0.1 via flycast, but the Host header carries the original Fly
   * IPv6 address.  OpenClaw's gateway checks the Host header to classify
   * connections — a non-local Host causes it to treat the connection as
   * remote, triggering device-identity checks.
   *
   * Set by the Fly provider to `127.0.0.1:<port>` for loopback-bound
   * gateways.  `undefined` means "use the default Host header".
   */
  hostOverride?: string;
}

/**
 * Build extra headers needed for proxying to a gateway target.
 * Returns an object with a Host override when the provider requires it,
 * or an empty object otherwise — safe to spread into any headers bag.
 */
export const gatewayHostHeaders = (
  target: GatewayTarget,
): Record<string, string> =>
  target.hostOverride ? { Host: target.hostOverride } : {};

// ---------------------------------------------------------------------------
// Assistant record projections (used by callers of the public API)
// ---------------------------------------------------------------------------

export type AssistantContainerRuntimeRef = Pick<
  AssistantRecord,
  | "id"
  | "owner_telegram_user_id"
  | "assistant_bot_id"
  | "assistant_bot_token"
  | "litellm_user_id"
  | "litellm_key_alias"
  | "litellm_virtual_key"
  | "litellm_key_last4"
  | "litellm_spend_usd"
  | "litellm_budget_usd"
  | "litellm_budget_duration"
  | "litellm_rpm_limit"
  | "litellm_tpm_limit"
  | "litellm_last_synced_at"
  | "container_name"
  | "container_id"
  | "container_port"
>;

export type AssistantContainerDestroyRef = Pick<
  AssistantRecord,
  "id" | "assistant_bot_id" | "container_name" | "container_id"
>;

export type AssistantContainerGatewayRef = Pick<
  AssistantRecord,
  "assistant_bot_id" | "container_id" | "container_port"
>;

// ---------------------------------------------------------------------------
// ContainerRuntime — pure infrastructure abstraction (no DB, no notifications)
// ---------------------------------------------------------------------------

export type ContainerState =
  | "running"
  | "stopped"
  | "creating"
  | "missing"
  | "error"
  | "unknown";

export interface ContainerRef {
  /** Runtime-opaque identifier (e.g. "fly:machineId|ip" or a Docker container ID). */
  id: string;
  name: string;
  state: ContainerState;
  /** Container's current env vars — used by the orchestrator for drift detection. */
  env?: Record<string, string> | undefined;
  image?: string | undefined;
  resources?: { memoryMb?: number; cpus?: number } | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
  /** Runtime-specific data (Fly: privateIp, machineId; Docker: hostPort). */
  metadata: Record<string, string>;
}

export interface AssistantContainerParams {
  assistantBotId: number;
  assistantId: number;
  ownerTelegramUserId: string | null;
  containerName: string;
  gatewayToken: string;
  assistantBotToken: string | null;
  liteLlmApiKey: string | null;
  onboardingProfileText?: string | null;
  onboardingProfileSource?: "connector" | "privy" | null;
  googleCredentialsB64?: string | null;
  skillsConfig?: Record<string, unknown> | null;
  /** Docker needs a pre-allocated host port. */
  containerPort?: number;
}

export interface ProbeOptions {
  timeoutMs: number;
  gatewayToken?: string;
  gatewayPort: number;
  additionalPorts?: number[];
  httpProbes?: Array<{ port: number; path: string }>;
  /** Fires as soon as gateway WebSocket hello succeeds (before supplementary probes). */
  onGatewayReady?: () => void;
}

export interface ContainerRuntime {
  readonly name: string;

  /** One-time initialization (e.g. Fly image digest check, Docker cron sanitization). */
  prepare(): Promise<void>;

  /** Find an existing container by its runtime-specific ref or fallback names. */
  findContainer(
    currentRef: string | null,
    fallbackNames: string[],
  ): Promise<ContainerRef | null>;

  /** Create a new container. Returns the created container ref. */
  createContainer(params: AssistantContainerParams): Promise<ContainerRef>;

  /** Start a stopped/created container. Waits until running or error. */
  startContainer(containerId: string): Promise<ContainerRef>;

  /** Stop a running container. */
  stopContainer(containerId: string): Promise<void>;

  /** Destroy a container permanently. */
  destroyContainer(containerId: string): Promise<void>;

  /** List all managed containers (for state sync). */
  listContainers(): Promise<ContainerRef[]>;

  /** Resolve gateway connectivity for a container. */
  resolveGatewayTarget(ref: ContainerRef): GatewayTarget;

  /** Pure infrastructure probe — no side effects. */
  probeReady(ref: ContainerRef, options: ProbeOptions): Promise<boolean>;

  /** Check if a container's config has drifted from desired params. */
  needsRecreation(
    ref: ContainerRef,
    params: AssistantContainerParams,
  ): Promise<boolean>;
}
