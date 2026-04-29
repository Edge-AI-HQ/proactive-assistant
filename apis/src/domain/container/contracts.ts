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
 *
 * Handles both Host and Origin overrides so that every consumer
 * (RPC, WS relay, probe) gets consistent headers from one place.
 *
 * On Fly, the real httpBaseUrl is an internal IPv6 address that won't
 * match the gateway's allowedOrigins or Host header.  When hostOverride
 * is set we derive Origin from it so the gateway's
 * `dangerouslyAllowHostHeaderOriginFallback` check (Origin == Host) passes.
 */
export const gatewayHostHeaders = (
  target: GatewayTarget,
): Record<string, string> => {
  if (!target.hostOverride) {
    return { Origin: target.httpBaseUrl };
  }
  return {
    Host: target.hostOverride,
    Origin: `http://${target.hostOverride}`,
  };
};

// ---------------------------------------------------------------------------
// ContainerRuntime — pure infrastructure abstraction (no DB, no notifications)
// ---------------------------------------------------------------------------

export type ContainerState =
  | "running"
  | "stopped"
  | "suspended"
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

/**
 * Generic container creation params — runtime-agnostic.
 * Used by the proactive-ai container orchestrator.
 */
export interface GenericContainerParams {
  containerName: string;
  gatewayToken: string;
  env: Record<string, string>;
  /** Volume name prefix (provider builds the full name). */
  volumeKey?: string;
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

  /** Create a container with explicit env vars. */
  createGenericContainer(params: GenericContainerParams): Promise<ContainerRef>;

  /** Start a stopped/created container. Waits until running or error. */
  startContainer(containerId: string): Promise<ContainerRef>;

  /** Stop a running container. */
  stopContainer(containerId: string): Promise<void>;

  /**
   * Suspend a running container (Fly: Firecracker snapshot, Docker: SIGSTOP pause).
   * Resume is fast — Fly ~hundreds of ms, Docker ~instant.
   */
  suspendContainer(containerId: string): Promise<void>;

  /** Destroy a container permanently. Persistent state (host bind-mount /
   *  Fly volume) is preserved — see destroyContainerVolume for that. */
  destroyContainer(containerId: string): Promise<void>;

  /**
   * Destroy the persistent state owned by a container (host bind-mount
   * directory on Docker, named volume on Fly).
   *
   * MUST only be called by `deleteAccount`. `destroyContainer` and
   * `resetContainer` deliberately leave persistent state intact so that
   * "Recreate" preserves user workspace, agents, and OpenClaw caches.
   */
  destroyContainerVolume(params: {
    containerName: string;
    /** Provider-specific volume identifier; falls back to containerName. */
    volumeKey?: string;
  }): Promise<void>;

  /** List all managed containers (for state sync). */
  listContainers(): Promise<ContainerRef[]>;

  /** Resolve gateway connectivity for a container. */
  resolveGatewayTarget(ref: ContainerRef): GatewayTarget;

  /** Pure infrastructure probe — no side effects. */
  probeReady(ref: ContainerRef, options: ProbeOptions): Promise<boolean>;
}
