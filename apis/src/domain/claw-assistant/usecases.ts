import type { AssistantRecord } from "../../types.js";
import { DomainError } from "../common/errors.js";
import {
  listAssistantsByOwnerTelegramUserId,
  provisionAssistant,
  createAssistantWithoutContainer,
  readAssistantById,
  removeAssistantById,
  type ProvisionAssistantInput,
} from "./service.js";

const parsePositiveInt = (value: unknown): number | null => {
  const raw =
    typeof value === "string"
      ? value.trim()
      : typeof value === "number"
        ? String(value)
        : "";
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return parsed;
};

export const parseTelegramUserIdParam = (value: unknown): number => {
  const parsed = parsePositiveInt(value);
  if (!parsed)
    throw new DomainError("INVALID_INPUT", "Invalid telegram_user_id");
  return parsed;
};

export const parseAssistantIdParam = (value: unknown): number => {
  const parsed = parsePositiveInt(value);
  if (!parsed) throw new DomainError("INVALID_INPUT", "Invalid assistant_id");
  return parsed;
};

export const parseProvisionAssistantInput = (
  body: unknown,
): ProvisionAssistantInput => {
  if (!body || typeof body !== "object") {
    throw new DomainError(
      "INVALID_INPUT",
      "Invalid payload. owner_telegram_user_id is required.",
    );
  }
  const record = body as Record<string, unknown>;

  const ownerTelegramUserId = parsePositiveInt(record.owner_telegram_user_id);
  if (!ownerTelegramUserId) {
    throw new DomainError(
      "INVALID_INPUT",
      "Invalid payload. owner_telegram_user_id is required.",
    );
  }

  // Bot 字段现在是可选的（Quick Start 模式下为空）
  const assistantBotId = parsePositiveInt(record.assistant_bot_id);
  const assistantBotToken =
    typeof record.assistant_bot_token === "string"
      ? record.assistant_bot_token.trim()
      : "";
  const assistantBotUsername =
    typeof record.assistant_bot_username === "string"
      ? record.assistant_bot_username.trim()
      : "";
  const ownerTelegramUsername =
    typeof record.owner_telegram_username === "string" &&
    record.owner_telegram_username.trim().length > 0
      ? record.owner_telegram_username.trim()
      : null;

  return {
    ownerTelegramUserId,
    ownerTelegramUsername,
    assistantBotId: assistantBotId || null,
    assistantBotToken: assistantBotToken || null,
    assistantBotUsername: assistantBotUsername || null,
  };
};

export const provisionAssistantByInput = async (
  input: ProvisionAssistantInput,
): Promise<{ assistant: AssistantRecord; ready: boolean }> => {
  try {
    return await provisionAssistant(input);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    if (message === "ASSISTANT_BOT_ALREADY_OWNED") {
      throw new DomainError("CONFLICT", message, 409, error);
    }
    if (message === "USER_ALREADY_HAS_ASSISTANT") {
      throw new DomainError("CONFLICT", message, 409, error);
    }
    throw error;
  }
};

export const createAssistantWithoutContainerByInput = async (
  input: ProvisionAssistantInput,
): Promise<{ assistant: AssistantRecord }> => {
  try {
    return await createAssistantWithoutContainer(input);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    if (message === "ASSISTANT_BOT_ALREADY_OWNED") {
      throw new DomainError("CONFLICT", message, 409, error);
    }
    if (message === "USER_ALREADY_HAS_ASSISTANT") {
      throw new DomainError("CONFLICT", message, 409, error);
    }
    throw error;
  }
};

export const listAssistantsByOwnerId = async (
  ownerTelegramUserId: number,
): Promise<AssistantRecord[]> => {
  return listAssistantsByOwnerTelegramUserId(ownerTelegramUserId);
};

export const readAssistantByIdOrThrow = async (
  assistantId: number,
): Promise<AssistantRecord> => {
  const assistant = await readAssistantById(assistantId);
  if (!assistant) {
    throw new DomainError("NOT_FOUND", "Assistant not found");
  }
  return assistant;
};

export const removeAssistantByIdOrThrow = async (
  assistantId: number,
): Promise<AssistantRecord> => {
  const removed = await removeAssistantById(assistantId);
  if (!removed) {
    throw new DomainError("NOT_FOUND", "Assistant not found");
  }
  return removed;
};
