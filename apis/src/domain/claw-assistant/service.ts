import {
  destroyAssistantContainer,
  ensureAssistantContainer,
} from "../container/index.js";
import { containerNameForAssistant } from "../container/naming.js";
import { ensureLiteLLMKeyForAssistant } from "../litellm/index.js";
import {
  createAssistant,
  deleteAssistantById,
  getAssistantByBotId,
  getAssistantById,
  getAssistantByBotToken,
  listAssistantsByOwnerTelegramId,
  updateAssistant,
} from "../common/db/index.js";
import { ensureTelegramUser } from "../user/service.js";
import type { AssistantRecord } from "../../types.js";

export interface ProvisionAssistantInput {
  ownerTelegramUserId: number;
  ownerTelegramUsername?: string | null;
  assistantBotId: number;
  assistantBotToken: string;
  assistantBotUsername: string;
}

const ensureAssistantRecord = async (
  ownerTelegramUserId: number,
  assistantBotId: number,
  assistantBotToken: string,
  assistantBotUsername: string,
): Promise<AssistantRecord> => {
  const defaultContainerName = containerNameForAssistant(assistantBotId);
  const existingByBotId = await getAssistantByBotId(assistantBotId);

  if (existingByBotId) {
    if (existingByBotId.owner_telegram_user_id !== ownerTelegramUserId) {
      throw new Error("ASSISTANT_BOT_ALREADY_OWNED");
    }

    return (
      (await updateAssistant(existingByBotId.id, {
        assistant_bot_token: assistantBotToken,
        assistant_bot_username: assistantBotUsername,
        container_name:
          existingByBotId.container_name?.trim() || defaultContainerName,
      })) ?? existingByBotId
    );
  }

  const existingByToken = await getAssistantByBotToken(assistantBotToken);
  if (
    existingByToken &&
    existingByToken.owner_telegram_user_id !== ownerTelegramUserId
  ) {
    throw new Error("ASSISTANT_BOT_ALREADY_OWNED");
  }

  const created = await createAssistant({
    owner_telegram_user_id: ownerTelegramUserId,
    assistant_bot_id: assistantBotId,
    assistant_bot_token: assistantBotToken,
    assistant_bot_username: assistantBotUsername,
    container_name: defaultContainerName,
    container_id: defaultContainerName,
    container_status: "creating",
  });

  if (!created) {
    throw new Error(`Failed to create assistant for bot ${assistantBotId}`);
  }

  return created;
};

export const provisionAssistant = async (
  input: ProvisionAssistantInput,
): Promise<{ assistant: AssistantRecord; ready: boolean }> => {
  const owner = await ensureTelegramUser(
    input.ownerTelegramUserId,
    input.ownerTelegramUsername ?? null,
  );

  const assistant = await ensureAssistantRecord(
    input.ownerTelegramUserId,
    input.assistantBotId,
    input.assistantBotToken,
    input.assistantBotUsername,
  );

  const assistantWithLiteLLM = await ensureLiteLLMKeyForAssistant(
    input.ownerTelegramUserId,
    assistant,
  );
  const { containerId, ready } = await ensureAssistantContainer(
    assistantWithLiteLLM,
    owner.gateway_token,
  );

  const finalAssistant =
    (await updateAssistant(assistantWithLiteLLM.id, {
      container_id: containerId,
      container_status: ready ? "running" : "creating",
    })) ?? assistantWithLiteLLM;

  return {
    assistant: finalAssistant,
    ready,
  };
};

export const createAssistantWithoutContainer = async (
  input: ProvisionAssistantInput,
): Promise<{ assistant: AssistantRecord }> => {
  await ensureTelegramUser(
    input.ownerTelegramUserId,
    input.ownerTelegramUsername ?? null,
  );

  const assistant = await ensureAssistantRecord(
    input.ownerTelegramUserId,
    input.assistantBotId,
    input.assistantBotToken,
    input.assistantBotUsername,
  );

  const assistantWithLiteLLM = await ensureLiteLLMKeyForAssistant(
    input.ownerTelegramUserId,
    assistant,
  );

  // Update status to pending payment
  const finalAssistant =
    (await updateAssistant(assistantWithLiteLLM.id, {
      container_status: "stopped",
    })) ?? assistantWithLiteLLM;

  return {
    assistant: finalAssistant,
  };
};

export const listAssistantsByOwnerTelegramUserId = (
  ownerTelegramUserId: number,
): Promise<AssistantRecord[]> =>
  listAssistantsByOwnerTelegramId(ownerTelegramUserId);

export const readAssistantById = (
  assistantId: number,
): Promise<AssistantRecord | undefined> => getAssistantById(assistantId);

export const removeAssistantById = async (
  assistantId: number,
): Promise<AssistantRecord | undefined> => {
  const assistant = await getAssistantById(assistantId);
  if (!assistant) return undefined;

  await destroyAssistantContainer({
    id: assistant.id,
    assistant_bot_id: assistant.assistant_bot_id,
    container_id: assistant.container_id,
    container_name: assistant.container_name,
  });

  return deleteAssistantById(assistantId);
};
