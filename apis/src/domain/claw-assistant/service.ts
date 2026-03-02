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
  assistantBotId?: number | null;
  assistantBotToken?: string | null;
  assistantBotUsername?: string | null;
}

const ensureAssistantRecord = async (
  ownerTelegramUserId: number,
  assistantBotId: number | null | undefined,
  assistantBotToken: string | null | undefined,
  assistantBotUsername: string | null | undefined,
): Promise<AssistantRecord> => {
  // 限制：一个用户只能创建一个 assistant
  const existingAssistants =
    await listAssistantsByOwnerTelegramId(ownerTelegramUserId);

  if (existingAssistants.length > 0) {
    const existing = existingAssistants[0];
    if (!existing) {
      throw new Error("USER_ALREADY_HAS_ASSISTANT");
    }

    // 如果用户已有助理，允许更新 bot 信息（从 Quick Start 升级到 Advanced）
    // 或者更新 bot token（重新绑定）
    if (assistantBotId !== null && assistantBotId !== undefined) {
      const defaultContainerName = containerNameForAssistant(assistantBotId);
      return (
        (await updateAssistant(existing.id, {
          assistant_bot_id: assistantBotId,
          assistant_bot_token:
            assistantBotToken || existing.assistant_bot_token,
          assistant_bot_username:
            assistantBotUsername || existing.assistant_bot_username,
          container_name:
            existing.container_name?.trim() || defaultContainerName,
        })) ?? existing
      );
    }

    // 已有助理且不更新 bot 信息，直接返回
    return existing;
  }

  // 用户还没有助理，创建新的
  // Quick Start 模式：assistantBotId = null
  // Advanced 模式：assistantBotId = 具体值
  const defaultContainerName = assistantBotId
    ? containerNameForAssistant(assistantBotId)
    : `assistant-${ownerTelegramUserId}`;

  const created = await createAssistant({
    owner_telegram_user_id: ownerTelegramUserId,
    assistant_bot_id: assistantBotId ?? null,
    assistant_bot_token: assistantBotToken ?? null,
    assistant_bot_username: assistantBotUsername ?? null,
    container_name: defaultContainerName,
    container_id: defaultContainerName,
    container_status: "creating",
  });

  if (!created) {
    throw new Error(
      `Failed to create assistant for user ${ownerTelegramUserId}`,
    );
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
    input.assistantBotId ?? null,
    input.assistantBotToken ?? null,
    input.assistantBotUsername ?? null,
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
    input.assistantBotId ?? null,
    input.assistantBotToken ?? null,
    input.assistantBotUsername ?? null,
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
