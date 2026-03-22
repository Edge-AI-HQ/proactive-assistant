import { getContainerRuntime } from "./provider_factory.js";
import { getContainerManagerRuntime } from "./runtime.js";
import { ContainerOrchestrator } from "./orchestrator.js";
import type {
  AssistantContainerDestroyRef,
  AssistantContainerGatewayRef,
  AssistantContainerRuntimeRef,
  GatewayTarget,
} from "./contracts.js";

// ---------------------------------------------------------------------------
// Lazy singleton orchestrator — constructed on first use from runtime config
// ---------------------------------------------------------------------------

let orchestrator: ContainerOrchestrator | null = null;

const getOrchestrator = (): ContainerOrchestrator => {
  if (!orchestrator) {
    const runtime = getContainerRuntime();
    const mgr = getContainerManagerRuntime();
    orchestrator = new ContainerOrchestrator(
      runtime,
      mgr.store,
      mgr.notifier,
      mgr.config,
      mgr.readAssistantLiteLLMVirtualKey,
    );
  }
  return orchestrator;
};

// ---------------------------------------------------------------------------
// Public API — same signatures as before, now delegating to orchestrator
// ---------------------------------------------------------------------------

export const prepareContainerRuntime = async (): Promise<void> => {
  await getOrchestrator().prepareRuntime();
};

export const ensureAssistantContainer = async (
  assistant: AssistantContainerRuntimeRef,
  gatewayToken: string,
  options?: { allowRecreate?: boolean },
): Promise<{ containerId: string; ready: boolean }> => {
  return getOrchestrator().ensureAssistantContainer(
    assistant,
    gatewayToken,
    options,
  );
};

export const destroyAssistantContainer = async (
  assistant: AssistantContainerDestroyRef,
): Promise<{ deleted: boolean }> => {
  return getOrchestrator().destroyAssistantContainer(assistant);
};

export const stopAssistantContainer = async (
  assistant: AssistantContainerDestroyRef,
): Promise<{ stopped: boolean }> => {
  return getOrchestrator().stopAssistantContainer(assistant);
};

export const suspendAssistantContainer = async (
  assistant: AssistantContainerDestroyRef,
): Promise<{ suspended: boolean }> => {
  return getOrchestrator().suspendAssistantContainer(assistant);
};

export const resumeAssistantContainer = async (
  assistant: AssistantContainerDestroyRef,
): Promise<{ resumed: boolean; durationMs: number }> => {
  return getOrchestrator().resumeAssistantContainer(assistant);
};

export const resolveGatewayTargetForAssistant = (
  assistant: AssistantContainerGatewayRef,
): GatewayTarget => {
  return getOrchestrator().resolveGatewayTargetForAssistant(assistant);
};

// Re-export for state sync
export { getOrchestrator };
