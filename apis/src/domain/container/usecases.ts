import { config } from '../common/config.js';
import { getAssistantById, getUserByTelegramId, deleteAssistantRuntimeMetadataKey } from '../common/db/index.js';
import { DomainError } from '../common/errors.js';
import { destroyAssistantContainer, ensureAssistantContainer } from './index.js';
import { clearCommandMenuForAssistant } from '../telegram-router/commandMenu.js';

const parsePositiveInt = (value: unknown): number | null => {
  const raw = typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return parsed;
};

export const parseAssistantIdParam = (value: unknown): number => {
  const assistantId = parsePositiveInt(value);
  if (!assistantId) throw new DomainError('INVALID_INPUT', 'Invalid assistant_id');
  return assistantId;
};

export const readContainerRuntime = (): { runtime: 'docker' | 'fly' } => ({
  runtime: config.container.runtime
});

const readAssistantWithOwnerGatewayTokenOrThrow = async (assistantId: number) => {
  const assistant = await getAssistantById(assistantId);
  if (!assistant) throw new DomainError('NOT_FOUND', 'Assistant not found');

  const owner = await getUserByTelegramId(assistant.owner_telegram_user_id);
  if (!owner) throw new DomainError('NOT_FOUND', 'Owner user not found');

  return { assistant, ownerGatewayToken: owner.gateway_token };
};

export const createAssistantContainerById = async (assistantId: number) => {
  const { assistant, ownerGatewayToken } = await readAssistantWithOwnerGatewayTokenOrThrow(assistantId);
  return ensureAssistantContainer(assistant, ownerGatewayToken);
};

export const deleteAssistantContainerById = async (assistantId: number): Promise<{ deleted: boolean }> => {
  const { assistant } = await readAssistantWithOwnerGatewayTokenOrThrow(assistantId);
  const result = await destroyAssistantContainer({
    id: assistant.id,
    assistant_bot_id: assistant.assistant_bot_id,
    container_id: assistant.container_id,
    container_name: assistant.container_name
  });
  clearCommandMenuForAssistant(
    String(assistant.owner_telegram_user_id),
    assistant.assistant_bot_token,
  ).catch((e) => console.error("Failed to clear command menu:", e));
  return result;
};

export const repairAssistantContainerById = async (
  assistantId: number,
): Promise<{ deleted: boolean; containerId: string; ready: boolean }> => {
  // Clear the onboarding notification lock so that the post-repair
  // probeAndNotify cycle can re-send the "ready" Telegram message.
  await deleteAssistantRuntimeMetadataKey(
    assistantId,
    "onboarding_ready_notified_at",
  ).catch((e) =>
    console.warn(
      `[repair] Failed to clear ready-notify lock for assistant ${assistantId}`,
      e,
    ),
  );

  const deleted = await deleteAssistantContainerById(assistantId);
  const recreated = await createAssistantContainerById(assistantId);
  return {
    deleted: deleted.deleted,
    containerId: recreated.containerId,
    ready: recreated.ready,
  };
};
