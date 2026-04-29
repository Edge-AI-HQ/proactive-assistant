import type {
  ContainerRef,
  ContainerRuntime,
  ContainerState,
  GatewayTarget,
  GenericContainerParams,
  ProbeOptions,
} from "../../contracts.js";
import {
  createMachine as createFlyMachine,
  createVolume,
  destroyMachine,
  destroyVolume,
  getMachine,
  isNotFoundError,
  listMachines,
  listVolumes,
  startMachine,
  stopMachine,
  suspendMachine,
} from "./fly_client.js";
import {
  formatHostForUrl,
  probeGatewayReady,
} from "../shared/gateway_probe.js";
import type { FlyMachine } from "./types.js";
import { config } from "../../../common/config.js";

const FLY_REF_PREFIX = "fly:";
/** 20GB encrypted volume formatting takes ~5-6 min; extend wait accordingly. */
const FLY_MACHINE_WAIT_TIMEOUT_MS = 360_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const parseFlyContainerRef = (
  value: string | null | undefined,
): { machineId: string; privateIp?: string } | null => {
  if (!value) return null;
  if (value.startsWith(FLY_REF_PREFIX)) {
    const payload = value.slice(FLY_REF_PREFIX.length);
    const [machineId, privateIpRaw] = payload.split("|", 2);
    const privateIp = privateIpRaw?.trim();
    if (!machineId) return null;
    return privateIp ? { machineId, privateIp } : { machineId };
  }
  return { machineId: value };
};

const encodeFlyContainerRef = (
  machineId: string,
  privateIp?: string,
): string =>
  privateIp
    ? `${FLY_REF_PREFIX}${machineId}|${privateIp}`
    : `${FLY_REF_PREFIX}${machineId}`;

const normalizeMachineState = (machine: FlyMachine): ContainerState => {
  const state = (machine.state || "").toLowerCase();
  if (state === "started" || state === "running") return "running";
  if (state === "stopped") return "stopped";
  if (state === "suspended" || state === "suspending") return "suspended";
  if (state === "created" || state === "starting") return "creating";
  if (state === "destroyed") return "missing";
  return (state || "unknown") as ContainerState;
};

const machineToContainerRef = (machine: FlyMachine): ContainerRef => {
  const metadata: Record<string, string> = { machineId: machine.id };
  if (machine.private_ip) metadata.privateIp = machine.private_ip;

  const resources: ContainerRef["resources"] = {};
  if (machine.config?.guest?.memory_mb != null) {
    resources.memoryMb = machine.config.guest.memory_mb;
  }
  if (machine.config?.guest?.cpus != null) {
    resources.cpus = machine.config.guest.cpus;
  }

  return {
    id: encodeFlyContainerRef(machine.id, machine.private_ip),
    name: machine.name?.trim() || "",
    state: normalizeMachineState(machine),
    env: machine.config?.env,
    image: machine.config?.image?.trim(),
    resources,
    createdAt: machine.created_at,
    updatedAt: machine.updated_at,
    metadata,
  };
};

const resolveMachineByRef = async (
  containerId: string | null | undefined,
  fallbackNames: string[],
): Promise<FlyMachine | null> => {
  const ref = parseFlyContainerRef(containerId);
  if (ref?.machineId) {
    try {
      return await getMachine(ref.machineId);
    } catch (error: unknown) {
      if (!isNotFoundError(error)) throw error;
    }
  }

  const fallbackNameSet = new Set(
    fallbackNames.map((item) => item.trim()).filter(Boolean),
  );
  if (!fallbackNameSet.size) return null;

  const machines = await listMachines();
  return machines.find(
    (machine) => machine.name && fallbackNameSet.has(machine.name),
  ) ?? null;
};

const waitForMachineState = async (
  machineId: string,
  desired: Set<string>,
  timeoutMs = 45_000,
): Promise<FlyMachine> => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const machine = await getMachine(machineId);
    const state = (machine.state || "").toLowerCase();
    if (desired.has(state)) return machine;
    if (state === "destroyed") return machine;
    await sleep(1000);
  }
  return getMachine(machineId);
};

const toGatewayTarget = (host: string, port: number): GatewayTarget => {
  const urlHost = formatHostForUrl(host);
  return {
    host,
    port,
    httpBaseUrl: `http://${urlHost}:${port}`,
    wsBaseUrl: `ws://${urlHost}:${port}`,
    // Fly routes cross-machine traffic through flycast, so the TCP connection
    // arrives at 127.0.0.1 but the Host header carries the Fly IPv6 address.
    // Override Host so OpenClaw's loopback gateway classifies it as local.
    hostOverride: `127.0.0.1:${port}`,
  };
};

const resolveHostFromRef = (ref: ContainerRef): string => {
  const privateIp = ref.metadata.privateIp;
  const machineId = ref.metadata.machineId;
  if (privateIp) return privateIp;
  if (machineId)
    return `${machineId}.vm.${config.fly.assistantAppName}.internal`;

  const parsed = parseFlyContainerRef(ref.id);
  if (parsed?.privateIp) return parsed.privateIp;
  if (parsed?.machineId)
    return `${parsed.machineId}.vm.${config.fly.assistantAppName}.internal`;

  throw new Error(`Cannot resolve Fly host for container ${ref.id}`);
};

export const flyContainerRuntime: ContainerRuntime = {
  name: "fly",

  async prepare(): Promise<void> {
    // No-op: image digest validation removed alongside legacy assistant flow.
  },

  async findContainer(
    currentRef: string | null,
    fallbackNames: string[],
  ): Promise<ContainerRef | null> {
    const machine = await resolveMachineByRef(currentRef, fallbackNames);
    if (!machine) return null;

    // Re-fetch to get latest state (listMachines may return stale data)
    const fresh = await getMachine(machine.id);
    if (!fresh.updated_at && machine.updated_at) {
      fresh.updated_at = machine.updated_at;
    }
    if (!fresh.created_at && machine.created_at) {
      fresh.created_at = machine.created_at;
    }
    return machineToContainerRef(fresh);
  },

  async createGenericContainer(
    params: GenericContainerParams,
  ): Promise<ContainerRef> {
    const volumeKey = params.volumeKey ?? params.containerName;
    const volumeName = volumeKey.replace(/[^a-z0-9_]/g, "_").slice(0, 30);

    const volumes = await listVolumes();
    let volume = volumes.find(
      (v: { name: string; state?: string }) =>
        v.name === volumeName &&
        (!v.state || v.state === "created" || v.state === "ready"),
    );
    if (!volume) {
      volume = await createVolume(volumeName, config.fly.region);
    }

    const env: Record<string, string> = {
      ...params.env,
      OPENCLAW_HOME: "/app",
      OPENCLAW_GATEWAY_PORT: String(config.openclaw.gatewayPort),
      OPENCLAW_GATEWAY_TOKEN: params.gatewayToken,
    };

    const machineBody = {
      name: params.containerName,
      region: volume.region ?? config.fly.region,
      config: {
        image: config.openclaw.image,
        env,
        guest: {
          cpu_kind: "shared",
          cpus: Math.max(1, config.fly.machineCpus),
          memory_mb: config.container.memoryMb,
        },
        mounts: [{ volume: volume.id, path: "/app" }],
        restart: { policy: "on-failure", max_retries: 3 },
        init: { exec: ["sh", "-lc", "exec pinai-entrypoint.sh"] },
      },
    };

    const machine = await createFlyMachine(machineBody);
    return machineToContainerRef(machine);
  },

  async startContainer(containerId: string): Promise<ContainerRef> {
    const parsed = parseFlyContainerRef(containerId);
    if (!parsed?.machineId) {
      throw new Error(`Invalid Fly container ref: ${containerId}`);
    }

    await startMachine(parsed.machineId);

    const machine = await waitForMachineState(
      parsed.machineId,
      new Set(["started", "running", "stopped", "destroyed"]),
      FLY_MACHINE_WAIT_TIMEOUT_MS,
    );
    return machineToContainerRef(machine);
  },

  async stopContainer(containerId: string): Promise<void> {
    const parsed = parseFlyContainerRef(containerId);
    if (!parsed?.machineId) {
      throw new Error(`Invalid Fly container ref: ${containerId}`);
    }
    try {
      await stopMachine(parsed.machineId);
    } catch (error: unknown) {
      if (!isNotFoundError(error)) throw error;
    }
  },

  async suspendContainer(containerId: string): Promise<void> {
    const parsed = parseFlyContainerRef(containerId);
    if (!parsed?.machineId) {
      throw new Error(`Invalid Fly container ref: ${containerId}`);
    }
    try {
      await suspendMachine(parsed.machineId);
    } catch (error: unknown) {
      if (!isNotFoundError(error)) throw error;
    }
  },

  async destroyContainer(containerId: string): Promise<void> {
    const parsed = parseFlyContainerRef(containerId);
    if (!parsed?.machineId) {
      throw new Error(`Invalid Fly container ref: ${containerId}`);
    }
    try {
      await destroyMachine(parsed.machineId);
    } catch (error: unknown) {
      if (!isNotFoundError(error)) throw error;
    }
  },

  async destroyContainerVolume(params: { containerName: string; volumeKey?: string }): Promise<void> {
    const volumeName = (params.volumeKey ?? params.containerName)
      .replace(/[^a-z0-9_]/g, "_")
      .slice(0, 30);
    let volumes;
    try {
      volumes = await listVolumes();
    } catch (err) {
      console.warn(`[fly] listVolumes failed during volume cleanup:`, err);
      return;
    }
    for (const vol of volumes) {
      if (vol.name === volumeName && vol.state !== 'pending_destroy') {
        try {
          await destroyVolume(vol.id);
        } catch (err) {
          console.warn(`[fly] destroyVolume(${vol.id}) failed:`, err);
        }
      }
    }
  },

  async listContainers(): Promise<ContainerRef[]> {
    const machines = await listMachines();
    return machines.map(machineToContainerRef);
  },

  resolveGatewayTarget(ref: ContainerRef): GatewayTarget {
    const host = resolveHostFromRef(ref);
    return toGatewayTarget(host, config.openclaw.gatewayPort);
  },

  async probeReady(
    ref: ContainerRef,
    options: ProbeOptions,
  ): Promise<boolean> {
    const host = resolveHostFromRef(ref);
    const target = toGatewayTarget(host, options.gatewayPort);
    return probeGatewayReady(
      {
        host,
        gatewayPort: options.gatewayPort,
        ...(target.hostOverride ? { hostOverride: target.hostOverride } : {}),
        ...(options.additionalPorts ? { additionalPorts: options.additionalPorts } : {}),
        ...(options.httpProbes ? { httpProbes: options.httpProbes } : {}),
      },
      options,
    );
  },
};
