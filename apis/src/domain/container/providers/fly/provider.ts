import { getContainerManagerRuntime } from '../../runtime.js';
import type {
  AssistantRecord,
  ContainerManagerConfig,
  ReadAssistantLiteLLMVirtualKey
} from '../../types.js';
import type {
  AssistantContainerDestroyRef,
  AssistantContainerGatewayRef,
  AssistantContainerRuntimeRef,
  ContainerProvider,
  GatewayTarget
} from '../../contracts.js';
import { containerNameForAssistant, isAssistantContainerName } from '../../naming.js';
import { resolveAssistantLiteLLMApiKey as resolveAssistantLiteLLMApiKeyShared } from '../shared/assistant_litellm_key.js';
import { destroyMachine, getMachine, isNotFoundError, listMachines, startMachine } from './fly_client.js';
import { formatHostForUrl, waitForGatewayHello, waitForPort } from './gateway_probe.js';
import { ensureFlyOpenclawImageDigestPullable } from './image_digest_guard.js';
import {
  createAssistantMachine as provisionAssistantMachine,
  getLatestAppDeployTimestampMs,
  shouldRecreateAssistantMachine
} from './assistant_machine.js';
import type { FlyMachine } from './types.js';

const config = new Proxy({} as ContainerManagerConfig, {
  get: (_target, prop) => getContainerManagerRuntime().config[prop as keyof ContainerManagerConfig]
});

const updateAssistant = (id: number, fields: Partial<AssistantRecord>) =>
  getContainerManagerRuntime().store.updateAssistant(id, fields);
const readAssistantLiteLLMVirtualKey: ReadAssistantLiteLLMVirtualKey = (assistant) =>
  getContainerManagerRuntime().readAssistantLiteLLMVirtualKey(assistant);

const FLY_REF_PREFIX = 'fly:';
const FLY_MACHINE_WAIT_TIMEOUT_MS = 120_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const parseFlyContainerRef = (value: string | null | undefined): { machineId: string; privateIp?: string } | null => {
  if (!value) return null;

  if (value.startsWith(FLY_REF_PREFIX)) {
    const payload = value.slice(FLY_REF_PREFIX.length);
    const [machineId, privateIpRaw] = payload.split('|', 2);
    const privateIp = privateIpRaw?.trim();
    if (!machineId) return null;
    return privateIp ? { machineId, privateIp } : { machineId };
  }

  if (isAssistantContainerName(value)) {
    return null;
  }
  return { machineId: value };
};

const encodeFlyContainerRef = (machineId: string, privateIp?: string): string =>
  privateIp ? `${FLY_REF_PREFIX}${machineId}|${privateIp}` : `${FLY_REF_PREFIX}${machineId}`;

const resolveAssistantLiteLLMApiKey = (assistant: AssistantContainerRuntimeRef): string | null =>
  resolveAssistantLiteLLMApiKeyShared(assistant, config.litellm.enabled, readAssistantLiteLLMVirtualKey);

const toGatewayTarget = (host: string): GatewayTarget => {
  const urlHost = formatHostForUrl(host);
  const port = config.openclaw.gatewayPort;
  return {
    host,
    port,
    httpBaseUrl: `http://${urlHost}:${port}`,
    wsBaseUrl: `ws://${urlHost}:${port}`
  };
};

const resolveFromMachine = (machineId: string, privateIp?: string): GatewayTarget => {
  const host = privateIp || `${machineId}.vm.${config.fly.appName}.internal`;
  return toGatewayTarget(host);
};

const resolveFlyGatewayTargetForAssistant = (assistant: AssistantContainerGatewayRef): GatewayTarget => {
  const parsed = parseFlyContainerRef(assistant.container_id);
  if (!parsed?.machineId) {
    throw new Error(`Missing Fly machine ID for assistant ${assistant.assistant_bot_id}`);
  }
  return resolveFromMachine(parsed.machineId, parsed.privateIp);
};

const waitForMachineState = async (
  machineId: string,
  desired: Set<string>,
  timeoutMs = 45_000
): Promise<FlyMachine> => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const machine = await getMachine(machineId);
    const state = (machine.state || '').toLowerCase();
    if (desired.has(state)) return machine;
    if (state === 'destroyed') return machine;
    await sleep(1000);
  }
  return getMachine(machineId);
};

const normalizeMachineState = (machine: FlyMachine): string => {
  const state = (machine.state || '').toLowerCase();
  if (state === 'started' || state === 'running') return 'running';
  if (state === 'stopped') return 'stopped';
  if (state === 'created' || state === 'starting') return 'creating';
  if (state === 'destroyed') return 'missing';
  return state || 'unknown';
};

const resolveMachineByRef = async (
  containerId: string | null | undefined,
  fallbackNames: string[]
): Promise<FlyMachine | null> => {
  const ref = parseFlyContainerRef(containerId);
  if (ref?.machineId) {
    try {
      return await getMachine(ref.machineId);
    } catch (error: unknown) {
      if (!isNotFoundError(error)) throw error;
    }
  }

  const fallbackNameSet = new Set(fallbackNames.map((item) => item.trim()).filter(Boolean));
  if (!fallbackNameSet.size) return null;

  const machines = await listMachines();
  const byName = machines.find((machine) => machine.name && fallbackNameSet.has(machine.name));
  return byName ?? null;
};

const resolveAssistantMachineName = (assistant: AssistantContainerRuntimeRef): string => {
  return assistant.container_name?.trim() || containerNameForAssistant(assistant.assistant_bot_id);
};

const resolveAssistantMachine = async (assistant: AssistantContainerRuntimeRef): Promise<FlyMachine | null> => {
  const fallbackNames = Array.from(
    new Set(
      [assistant.container_name?.trim(), containerNameForAssistant(assistant.assistant_bot_id)].filter(
        (value): value is string => Boolean(value)
      )
    )
  );
  return resolveMachineByRef(assistant.container_id, fallbackNames);
};

const createAssistantMachine = async (
  assistant: AssistantContainerRuntimeRef,
  gatewayToken: string,
  liteLlmApiKey = resolveAssistantLiteLLMApiKey(assistant)
): Promise<FlyMachine> => {
  return provisionAssistantMachine({
    assistantBotId: assistant.assistant_bot_id,
    machineName: resolveAssistantMachineName(assistant),
    gatewayToken,
    assistantBotToken: assistant.assistant_bot_token,
    liteLlmApiKey
  });
};

const persistAssistantMachineRef = async (
  assistantId: number,
  fallbackName: string,
  machine: FlyMachine
): Promise<string> => {
  const encoded = encodeFlyContainerRef(machine.id, machine.private_ip);
  await updateAssistant(assistantId, {
    container_id: encoded,
    container_name: machine.name?.trim() || fallbackName
  });
  return encoded;
};

const ensureAssistantInFlight = new Map<number, Promise<{ containerId: string; ready: boolean }>>();

const runEnsureAssistantMachine = async (
  assistant: AssistantContainerRuntimeRef,
  gatewayToken: string
): Promise<{ containerId: string; ready: boolean }> => {
  const normalizedGatewayToken = gatewayToken.trim();
  if (!normalizedGatewayToken) {
    throw new Error(`Assistant ${assistant.assistant_bot_id} missing gateway_token.`);
  }

  const desiredLiteLLMApiKey = resolveAssistantLiteLLMApiKey(assistant);
  await ensureFlyOpenclawImageDigestPullable();

  const fallbackName = resolveAssistantMachineName(assistant);
  let machine = await resolveAssistantMachine(assistant);

  if (machine) {
    const previous = machine;
    machine = await getMachine(machine.id);
    if (!machine.updated_at && previous.updated_at) {
      machine.updated_at = previous.updated_at;
    }
    if (!machine.created_at && previous.created_at) {
      machine.created_at = previous.created_at;
    }

    let latestAppDeployAtMs: number | null = null;
    try {
      latestAppDeployAtMs = await getLatestAppDeployTimestampMs();
    } catch (error: unknown) {
      console.warn('Failed to resolve latest app deployment timestamp', error);
    }

    if (
      shouldRecreateAssistantMachine(
        machine,
        latestAppDeployAtMs,
        normalizedGatewayToken,
        assistant.assistant_bot_token,
        desiredLiteLLMApiKey
      )
    ) {
      await destroyMachine(machine.id);
      machine = null;
      await updateAssistant(assistant.id, {
        container_status: 'creating',
        container_id: '',
        container_name: fallbackName
      });
    }
  }

  if (!machine) {
    machine = await createAssistantMachine(assistant, normalizedGatewayToken, desiredLiteLLMApiKey);
  }

  let currentState = normalizeMachineState(machine);
  if (currentState === 'missing') {
    await updateAssistant(assistant.id, {
      container_status: 'creating',
      container_id: '',
      container_name: fallbackName
    });
    machine = await createAssistantMachine(assistant, normalizedGatewayToken, desiredLiteLLMApiKey);
    currentState = normalizeMachineState(machine);
  }

  if (currentState !== 'running') {
    await startMachine(machine.id);
  }

  const startedMachine = await waitForMachineState(
    machine.id,
    new Set(['started', 'running', 'stopped', 'destroyed']),
    FLY_MACHINE_WAIT_TIMEOUT_MS
  );
  const containerId = await persistAssistantMachineRef(assistant.id, fallbackName, startedMachine);
  const status = normalizeMachineState(startedMachine);

  let ready = status === 'running';
  if (ready && config.fly.gatewayProbe) {
    const target = resolveFromMachine(startedMachine.id, startedMachine.private_ip);
    const portReady = await waitForPort(target.host, target.port, config.fly.gatewayProbeTimeoutMs);
    ready = portReady
      ? await waitForGatewayHello(target.host, target.port, normalizedGatewayToken, config.fly.gatewayProbeTimeoutMs)
      : false;
  }

  await updateAssistant(assistant.id, {
    container_status: ready ? 'running' : 'error',
    container_name: startedMachine.name?.trim() || fallbackName
  });

  return { containerId, ready };
};

const ensureAssistantFlyContainer = async (
  assistant: AssistantContainerRuntimeRef,
  gatewayToken: string
): Promise<{ containerId: string; ready: boolean }> => {
  const key = assistant.id;
  const existing = ensureAssistantInFlight.get(key);
  if (existing) return existing;

  const job = runEnsureAssistantMachine(assistant, gatewayToken).finally(() => {
    if (ensureAssistantInFlight.get(key) === job) {
      ensureAssistantInFlight.delete(key);
    }
  });

  ensureAssistantInFlight.set(key, job);
  return job;
};

const destroyAssistantFlyContainer = async (
  assistant: AssistantContainerDestroyRef
): Promise<{ deleted: boolean }> => {
  const fallbackName = assistant.container_name?.trim() || containerNameForAssistant(assistant.assistant_bot_id);
  const machine = await resolveMachineByRef(assistant.container_id, [
    fallbackName,
    containerNameForAssistant(assistant.assistant_bot_id)
  ]);

  if (!machine) {
    await updateAssistant(assistant.id, {
      container_status: 'missing',
      container_id: '',
      container_name: fallbackName
    });
    return { deleted: false };
  }

  try {
    await destroyMachine(machine.id);
  } catch (error: unknown) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

  await updateAssistant(assistant.id, {
    container_status: 'missing',
    container_id: '',
    container_name: fallbackName
  });

  return { deleted: true };
};

const prepareFlyRuntime = async (): Promise<void> => {
  await ensureFlyOpenclawImageDigestPullable();
};

export const flyContainerProvider: ContainerProvider = {
  prepareRuntime: prepareFlyRuntime,
  ensureAssistantContainer: ensureAssistantFlyContainer,
  destroyAssistantContainer: destroyAssistantFlyContainer,
  resolveGatewayTargetForAssistant: resolveFlyGatewayTargetForAssistant
};
