import { getContainerManagerRuntime } from "../../runtime.js";
import type { ContainerManagerConfig } from "../../types.js";
import type {
  AssistantContainerParams,
  ContainerRef,
  ContainerRuntime,
  ContainerState,
  GatewayTarget,
  ProbeOptions,
} from "../../contracts.js";
import { isAssistantContainerName } from "../../naming.js";
import {
  destroyMachine,
  getMachine,
  isNotFoundError,
  listMachines,
  startMachine,
  stopMachine,
} from "./fly_client.js";
import {
  formatHostForUrl,
  waitForGatewayHello,
  waitForHttpReady,
  waitForPort,
} from "./gateway_probe.js";
import { ensureFlyOpenclawImageDigestPullable } from "./image_digest_guard.js";
import {
  createAssistantMachine as provisionAssistantMachine,
  shouldRecreateAssistantMachine,
} from "./assistant_machine.js";
import type { FlyMachine } from "./types.js";

// ---------------------------------------------------------------------------
// Config proxy — lazily reads from the global runtime singleton
// ---------------------------------------------------------------------------

const config = new Proxy({} as ContainerManagerConfig, {
  get: (_target, prop) =>
    getContainerManagerRuntime().config[prop as keyof ContainerManagerConfig],
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FLY_REF_PREFIX = "fly:";
/** 20GB encrypted volume formatting takes ~5-6 min; extend wait accordingly. */
const FLY_MACHINE_WAIT_TIMEOUT_MS = 360_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Fly ref encoding / decoding
// ---------------------------------------------------------------------------

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

  if (isAssistantContainerName(value)) {
    return null;
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

// ---------------------------------------------------------------------------
// Helpers: FlyMachine → ContainerRef conversion
// ---------------------------------------------------------------------------

const normalizeMachineState = (machine: FlyMachine): ContainerState => {
  const state = (machine.state || "").toLowerCase();
  if (state === "started" || state === "running") return "running";
  if (state === "stopped") return "stopped";
  if (state === "created" || state === "starting") return "creating";
  if (state === "destroyed") return "missing";
  return (state || "unknown") as ContainerState;
};

const machineToContainerRef = (machine: FlyMachine): ContainerRef => {
  const metadata: Record<string, string> = {};
  if (machine.private_ip) metadata.privateIp = machine.private_ip;
  metadata.machineId = machine.id;

  // Preserve init.exec so needsRecreation can check it without re-fetching
  const initExec = machine.config?.init?.exec;
  if (Array.isArray(initExec) && initExec.length > 0) {
    metadata.initExec = JSON.stringify(initExec);
  }

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

// ---------------------------------------------------------------------------
// Internal: machine resolution
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Gateway target resolution
// ---------------------------------------------------------------------------

const toGatewayTarget = (host: string, port: number): GatewayTarget => {
  const urlHost = formatHostForUrl(host);
  return {
    host,
    port,
    httpBaseUrl: `http://${urlHost}:${port}`,
    wsBaseUrl: `ws://${urlHost}:${port}`,
  };
};

const resolveHostFromRef = (ref: ContainerRef): string => {
  // Prefer metadata (set when ContainerRef comes from listContainers/findContainer)
  const privateIp = ref.metadata.privateIp;
  const machineId = ref.metadata.machineId;
  if (privateIp) return privateIp;
  if (machineId)
    return `${machineId}.vm.${config.fly.assistantAppName}.internal`;

  // Fallback: parse from ref.id (e.g. when built from a DB record by the orchestrator)
  const parsed = parseFlyContainerRef(ref.id);
  if (parsed?.privateIp) return parsed.privateIp;
  if (parsed?.machineId)
    return `${parsed.machineId}.vm.${config.fly.assistantAppName}.internal`;

  throw new Error(`Cannot resolve Fly host for container ${ref.id}`);
};

// ---------------------------------------------------------------------------
// ContainerRuntime implementation
// ---------------------------------------------------------------------------

export const flyContainerRuntime: ContainerRuntime = {
  name: "fly",

  async prepare(): Promise<void> {
    await ensureFlyOpenclawImageDigestPullable();
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

  async createContainer(
    params: AssistantContainerParams,
  ): Promise<ContainerRef> {
    const machine = await provisionAssistantMachine({
      assistantBotId: params.assistantBotId,
      machineName: params.containerName,
      gatewayToken: params.gatewayToken,
      assistantBotToken: params.assistantBotToken,
      ...(params.googleCredentialsB64 !== undefined
        ? { googleCredentialsB64: params.googleCredentialsB64 }
        : {}),
      liteLlmApiKey: params.liteLlmApiKey,
      ...(params.onboardingProfileText !== undefined
        ? { onboardingProfileText: params.onboardingProfileText }
        : {}),
      ...(params.onboardingProfileSource !== undefined
        ? { onboardingProfileSource: params.onboardingProfileSource }
        : {}),
      ...(params.skillsConfig ? { skillsConfig: params.skillsConfig } : {}),
    });
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
    const { timeoutMs, gatewayToken, gatewayPort, additionalPorts, httpProbes } = options;

    const portReady = await waitForPort(host, gatewayPort, timeoutMs);
    if (!portReady) return false;

    if (gatewayToken) {
      const gatewayOk = await waitForGatewayHello(
        host,
        gatewayPort,
        gatewayToken,
        timeoutMs,
      );
      if (!gatewayOk) return false;
    }

    if (additionalPorts?.length) {
      for (const port of additionalPorts) {
        const ok = await waitForPort(host, port, timeoutMs);
        if (!ok) return false;
      }
    }

    if (httpProbes?.length) {
      for (const probe of httpProbes) {
        const ok = await waitForHttpReady(host, probe.port, probe.path, timeoutMs);
        if (!ok) return false;
      }
    }

    return true;
  },

  async needsRecreation(
    ref: ContainerRef,
    params: AssistantContainerParams,
  ): Promise<boolean> {
    // Reconstruct a minimal FlyMachine from ContainerRef to reuse
    // shouldRecreateAssistantMachine without an extra Fly API call.
    const initExec = ref.metadata.initExec
      ? (JSON.parse(ref.metadata.initExec) as string[])
      : undefined;

    const machineConfig: FlyMachine["config"] = {
      guest: {
        memory_mb: ref.resources?.memoryMb ?? 0,
        cpus: ref.resources?.cpus ?? 0,
      },
    };
    if (ref.image != null) machineConfig.image = ref.image;
    if (ref.env != null) machineConfig.env = ref.env;
    if (initExec) machineConfig.init = { exec: initExec };

    const machine: FlyMachine = {
      id: ref.metadata.machineId || "",
      config: machineConfig,
    };
    if (ref.name) machine.name = ref.name;
    if (ref.state) machine.state = ref.state;
    if (ref.metadata.privateIp) machine.private_ip = ref.metadata.privateIp;
    if (ref.createdAt) machine.created_at = ref.createdAt;
    if (ref.updatedAt) machine.updated_at = ref.updatedAt;

    return shouldRecreateAssistantMachine(
      machine,
      params.gatewayToken,
      params.assistantBotToken,
      params.liteLlmApiKey,
      params.onboardingProfileText,
      params.onboardingProfileSource,
      params.skillsConfig,
    );
  },
};
