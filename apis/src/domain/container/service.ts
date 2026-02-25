import { getContainerProvider } from "./provider_factory.js";
import type {
  AssistantContainerDestroyRef,
  AssistantContainerGatewayRef,
  AssistantContainerRuntimeRef,
  GatewayTarget,
} from "./contracts.js";

export const prepareContainerRuntime = async (): Promise<void> => {
  await getContainerProvider().prepareRuntime();
};

export const ensureAssistantContainer = async (
  assistant: AssistantContainerRuntimeRef,
  gatewayToken: string,
): Promise<{ containerId: string; ready: boolean }> => {
  return getContainerProvider().ensureAssistantContainer(
    assistant,
    gatewayToken,
  );
};

export const destroyAssistantContainer = async (
  assistant: AssistantContainerDestroyRef,
): Promise<{ deleted: boolean }> => {
  return getContainerProvider().destroyAssistantContainer(assistant);
};

export const stopAssistantContainer = async (
  assistant: AssistantContainerDestroyRef,
): Promise<{ stopped: boolean }> => {
  return getContainerProvider().stopAssistantContainer(assistant);
};

export const resolveGatewayTargetForAssistant = (
  assistant: AssistantContainerGatewayRef,
): GatewayTarget => {
  return getContainerProvider().resolveGatewayTargetForAssistant(assistant);
};
