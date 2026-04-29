import fs from "node:fs";
import path from "node:path";
import Docker from "dockerode";
import type {
  ContainerRef,
  ContainerRuntime,
  ContainerState,
  GatewayTarget,
  GenericContainerParams,
  ProbeOptions,
} from "../../contracts.js";
import { probeGatewayReady, type ResolvedProbeTarget } from "../shared/gateway_probe.js";
import { config } from "../../../common/config.js";

const docker = new Docker();

// When APIs runs inside a container, bind-mount paths passed to the Docker
// daemon must use the *host* filesystem path, not the container-internal path.
// HOST_DATA_DIR tells us where the host's data directory is mounted from.
const HOST_DATA_DIR = (process.env.HOST_DATA_DIR || "").replace(/\/+$/, "");

// When APIs runs inside a container, 127.0.0.1 refers to the container itself.
// DOCKER_HOST_ADDRESS provides the address to reach the host's port-mapped
// containers (typically "host.docker.internal").
const DOCKER_HOST_ADDRESS = process.env.DOCKER_HOST_ADDRESS || "127.0.0.1";

interface DockerStatusCodeError {
  statusCode?: number;
}

const isStatusCodeError = (value: unknown): value is DockerStatusCodeError =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { statusCode?: unknown }).statusCode === "number";

const ensureDir = (dirPath: string): void => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
};

/** Translate a local data path to the host-side path for Docker bind mounts. */
const toHostBindPath = (localPath: string): string => {
  if (!HOST_DATA_DIR) return localPath;
  const localDataDir = path.join(process.cwd(), "data");
  if (!localPath.startsWith(localDataDir)) return localPath;
  return HOST_DATA_DIR + localPath.slice(localDataDir.length);
};

const normalizeDockerState = (status: string | undefined): ContainerState => {
  const s = (status || "").toLowerCase();
  if (s === "running") return "running";
  if (s === "paused") return "suspended";
  if (s === "exited" || s === "dead") return "stopped";
  if (s === "created" || s === "restarting") return "creating";
  if (s === "removing") return "missing";
  return "unknown";
};

const inspectToContainerRef = async (
  container: Docker.Container,
): Promise<ContainerRef> => {
  const inspect = await container.inspect();
  const envArr: string[] = inspect.Config?.Env || [];
  const env: Record<string, string> = {};
  for (const entry of envArr) {
    const idx = entry.indexOf("=");
    if (idx > 0) env[entry.slice(0, idx)] = entry.slice(idx + 1);
  }

  // Extract host port — prefer NetworkSettings.Ports (actual assigned port)
  // over HostConfig.PortBindings (which may be "0" for auto-assign).
  const networkPorts = (inspect.NetworkSettings as { Ports?: Record<string, Array<{ HostPort?: string }>> })?.Ports || {};
  const portBindings = inspect.HostConfig?.PortBindings || {};
  const gatewayPortKey = `${config.openclaw.gatewayPort}/tcp`;

  const extractHostPort = (containerPort: string): string => {
    const netBindings = networkPorts[containerPort];
    if (Array.isArray(netBindings) && netBindings.length > 0) {
      const binding = netBindings[0] as { HostPort?: string };
      if (binding.HostPort && binding.HostPort !== "0") return binding.HostPort;
    }
    const bindings = portBindings[containerPort];
    if (Array.isArray(bindings) && bindings.length > 0) {
      const binding = bindings[0] as { HostPort?: string };
      if (binding.HostPort && binding.HostPort !== "0") return binding.HostPort;
    }
    return "";
  };

  return {
    id: inspect.Id,
    name: (inspect.Name || "").replace(/^\//, ""),
    state: normalizeDockerState(inspect.State?.Status),
    env,
    image: inspect.Config?.Image,
    metadata: { hostPort: extractHostPort(gatewayPortKey) },
  };
};

const resolveDockerProbeTarget = (
  ref: ContainerRef,
  options: ProbeOptions,
): ResolvedProbeTarget => {
  const hostPort = Number(ref.metadata.hostPort) || options.gatewayPort;
  const httpProbes: Array<{ port: number; path: string }> = [];
  if (Array.isArray(options.httpProbes)) {
    for (const probe of options.httpProbes) {
      if (Number(probe.port) === config.openclaw.gatewayPort && hostPort > 0) {
        httpProbes.push({ port: hostPort, path: probe.path });
      }
    }
  }
  return { host: DOCKER_HOST_ADDRESS, gatewayPort: hostPort, additionalPorts: [], httpProbes };
};

export const dockerContainerRuntime: ContainerRuntime = {
  name: "docker",

  async prepare(): Promise<void> {
    // No-op for Docker. (Fly does image digest validation in its prepare.)
  },

  async findContainer(
    currentRef: string | null,
    fallbackNames: string[],
  ): Promise<ContainerRef | null> {
    if (currentRef) {
      try {
        const container = docker.getContainer(currentRef);
        const inspect = await container.inspect();
        if (inspect) return inspectToContainerRef(container);
      } catch {
        // fall through
      }
    }
    for (const name of fallbackNames) {
      const trimmed = name.trim();
      if (!trimmed) continue;
      try {
        const container = docker.getContainer(trimmed);
        const inspect = await container.inspect();
        if (inspect) return inspectToContainerRef(container);
      } catch {
        // continue
      }
    }
    return null;
  },

  async createGenericContainer(params: GenericContainerParams): Promise<ContainerRef> {
    const baseDir = path.join(process.cwd(), "data", params.containerName);
    ensureDir(path.join(baseDir, "data", "config"));

    const container = await docker.createContainer({
      name: params.containerName,
      Image: config.openclaw.image,
      Env: Object.entries(params.env).map(([k, v]) => `${k}=${v}`),
      ExposedPorts: { [`${config.openclaw.gatewayPort}/tcp`]: {} },
      HostConfig: {
        RestartPolicy: { Name: "unless-stopped" },
        ExtraHosts: ["host.docker.internal:host-gateway"],
        // HostPort: "0" → Docker auto-assigns a free port
        PortBindings: { [`${config.openclaw.gatewayPort}/tcp`]: [{ HostPort: "0" }] },
        Binds: [`${toHostBindPath(baseDir)}:/app`],
        Memory: config.container.memoryMb * 1024 * 1024,
        CpuShares: config.container.cpuShares,
      },
    });

    return inspectToContainerRef(container);
  },

  async startContainer(containerId: string): Promise<ContainerRef> {
    const container = docker.getContainer(containerId);
    const inspect = await container.inspect();
    const status = (inspect.State?.Status || "").toLowerCase();

    if (status === "paused") {
      await container.unpause();
    } else if (status !== "running") {
      try {
        await container.start();
      } catch (error: unknown) {
        if (!isStatusCodeError(error) || error.statusCode !== 304) throw error;
      }
    }

    return inspectToContainerRef(container);
  },

  async stopContainer(containerId: string): Promise<void> {
    const container = docker.getContainer(containerId);
    try {
      await container.stop();
    } catch (error: unknown) {
      if (!isStatusCodeError(error) || (error.statusCode !== 304 && error.statusCode !== 404)) {
        throw error;
      }
    }
  },

  async suspendContainer(containerId: string): Promise<void> {
    const container = docker.getContainer(containerId);
    try {
      await container.pause();
    } catch (error: unknown) {
      if (!isStatusCodeError(error) || (error.statusCode !== 304 && error.statusCode !== 404)) {
        throw error;
      }
    }
  },

  async destroyContainer(containerId: string): Promise<void> {
    const container = docker.getContainer(containerId);
    try {
      const inspect = await container.inspect();
      if (inspect.State?.Status === "running") {
        try {
          await container.stop();
        } catch (error: unknown) {
          if (!isStatusCodeError(error) || (error.statusCode !== 304 && error.statusCode !== 404)) {
            throw error;
          }
        }
      }
      await container.remove({ force: true });
    } catch (error: unknown) {
      if (!isStatusCodeError(error) || error.statusCode !== 404) throw error;
    }
  },

  /**
   * Wipe the host-side bind-mount directory for a container. Only called
   * by deleteAccount — destroy/reset must NOT trigger this, otherwise the
   * user loses workspace, agents, cron jobs, and OpenClaw cache when they
   * just wanted to recreate the container.
   */
  async destroyContainerVolume(params: { containerName: string; volumeKey?: string }): Promise<void> {
    void params.volumeKey;  // unused on docker; bind dir is keyed by containerName
    const localDir = path.join(process.cwd(), "data", params.containerName);
    if (!fs.existsSync(localDir)) return;
    try {
      fs.rmSync(localDir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[docker] Failed to remove host data dir ${localDir}:`, err);
    }
  },

  async listContainers(): Promise<ContainerRef[]> {
    const containers = await docker.listContainers({ all: true });
    return containers.map((info) => ({
      id: info.Id,
      name: (info.Names?.[0] || "").replace(/^\//, ""),
      state: normalizeDockerState(info.State),
      metadata: {},
    }));
  },

  resolveGatewayTarget(ref: ContainerRef): GatewayTarget {
    const hostPort = Number(ref.metadata.hostPort) || config.openclaw.gatewayPort;
    return {
      host: DOCKER_HOST_ADDRESS,
      port: hostPort,
      httpBaseUrl: `http://${DOCKER_HOST_ADDRESS}:${hostPort}`,
      wsBaseUrl: `ws://${DOCKER_HOST_ADDRESS}:${hostPort}`,
    };
  },

  async probeReady(
    ref: ContainerRef,
    options: ProbeOptions,
  ): Promise<boolean> {
    return probeGatewayReady(resolveDockerProbeTarget(ref, options), options);
  },
};
