import { getContainerManagerRuntime } from "../../runtime.js";
import type { ContainerManagerConfig } from "../../types.js";
import type { FlyMachine, FlyVolume } from "./types.js";

const config = new Proxy({} as ContainerManagerConfig, {
  get: (_target, prop) =>
    getContainerManagerRuntime().config[prop as keyof ContainerManagerConfig],
});

class FlyApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const isFlyConfigured = (): boolean =>
  Boolean(config.fly.apiToken && config.fly.appName);

const assertFlyConfigured = (): void => {
  if (!isFlyConfigured()) {
    throw new Error(
      "FLY_API_TOKEN and FLY_APP_NAME are required when CONTAINER_RUNTIME=fly",
    );
  }
};

const flyApiBase = (): string => config.fly.apiBaseUrl.replace(/\/+$/, "");

const appPath = (): string => `/apps/${encodeURIComponent(config.fly.appName)}`;

const flyRequest = async <T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> => {
  assertFlyConfigured();

  const requestInit: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${config.fly.apiToken}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
  };

  if (body !== undefined) {
    requestInit.body = JSON.stringify(body);
  }

  const response = await fetch(`${flyApiBase()}${path}`, requestInit);
  const raw = await response.text();

  if (!response.ok) {
    throw new FlyApiError(
      `Fly API ${method} ${path} failed (${response.status}): ${raw}`,
      response.status,
    );
  }

  if (!raw) return null as T;
  return JSON.parse(raw) as T;
};

const isConflictOrPreconditionError = (
  error: unknown,
): error is FlyApiError => {
  return (
    error instanceof FlyApiError &&
    (error.status === 409 || error.status === 412)
  );
};

const flyErrorMessage = (error: unknown): string => {
  return (
    error instanceof Error ? error.message : String(error || "")
  ).toLowerCase();
};

const isMachineStartAlreadyInProgress = (error: unknown): boolean => {
  if (!isConflictOrPreconditionError(error)) return false;
  const message = flyErrorMessage(error);
  return (
    message.includes("still active") ||
    message.includes("refusing to start") ||
    message.includes("current state invalid") ||
    message.includes("unable to start machine from current state")
  );
};

export const isNotFoundError = (error: unknown): boolean => {
  return error instanceof FlyApiError && error.status === 404;
};

export const isVolumeNotFoundError = (error: unknown): boolean => {
  if (!(error instanceof FlyApiError) || error.status !== 400) return false;
  return flyErrorMessage(error).includes("volume not found");
};

export const isMachineNameConflict = (error: unknown): boolean => {
  if (!(error instanceof FlyApiError) || error.status !== 409) return false;
  return flyErrorMessage(error).includes("name");
};

export const isVolumeAlreadyExists = (error: unknown): boolean => {
  if (!(error instanceof FlyApiError)) return false;
  if (error.status !== 409 && error.status !== 422) return false;
  const message = flyErrorMessage(error);
  return message.includes("exists") || message.includes("name");
};

export const isInsufficientResourcesError = (error: unknown): boolean => {
  if (!(error instanceof FlyApiError)) return false;
  if (error.status !== 409 && error.status !== 412) return false;
  const message = flyErrorMessage(error);
  return (
    message.includes("insufficient resources") ||
    message.includes("insufficient memory")
  );
};

export const listMachines = async (): Promise<FlyMachine[]> => {
  return flyRequest<FlyMachine[]>("GET", `${appPath()}/machines`);
};

export const getMachine = async (machineId: string): Promise<FlyMachine> => {
  return flyRequest<FlyMachine>(
    "GET",
    `${appPath()}/machines/${encodeURIComponent(machineId)}`,
  );
};

export const startMachine = async (machineId: string): Promise<void> => {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await flyRequest<unknown>(
        "POST",
        `${appPath()}/machines/${encodeURIComponent(machineId)}/start`,
      );
      return;
    } catch (error: unknown) {
      if (!isMachineStartAlreadyInProgress(error)) {
        throw error;
      }
      if (attempt >= 5) return;
      await sleep(1000 * attempt);
    }
  }
};

export const stopMachine = async (machineId: string): Promise<void> => {
  await flyRequest<unknown>(
    "POST",
    `${appPath()}/machines/${encodeURIComponent(machineId)}/stop`,
  );
};

export const destroyMachine = async (machineId: string): Promise<void> => {
  await flyRequest<unknown>(
    "DELETE",
    `${appPath()}/machines/${encodeURIComponent(machineId)}?force=true`,
  );
};

export const listVolumes = async (): Promise<FlyVolume[]> => {
  return flyRequest<FlyVolume[]>("GET", `${appPath()}/volumes`);
};

export const createVolume = async (
  name: string,
  region?: string,
): Promise<FlyVolume> => {
  const targetRegion = region ?? config.fly.region;
  return flyRequest<FlyVolume>("POST", `${appPath()}/volumes`, {
    name,
    region: targetRegion,
    size_gb: config.fly.volumeSizeGb,
  });
};

export const destroyVolume = async (volumeId: string): Promise<void> => {
  await flyRequest<unknown>(
    "DELETE",
    `${appPath()}/volumes/${encodeURIComponent(volumeId)}`,
  );
};

export const createMachine = async (body: unknown): Promise<FlyMachine> => {
  return flyRequest<FlyMachine>("POST", `${appPath()}/machines`, body);
};
