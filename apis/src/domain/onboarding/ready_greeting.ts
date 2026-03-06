import { pool } from "../common/db/core.js";
import {
  readAssistantRuntimeMetadata,
  setAssistantRuntimeMetadataKey,
} from "../common/db/runtimeRepository.js";
import { config } from "../common/config.js";
import {
  buildOnboardingGreetingPrompt,
  resolveExternalProfileForTelegramUser,
  shouldTriggerReadyGreeting,
} from "./profile_bootstrap.js";

const buildPrivateWebhookUpdate = (telegramUserId: number, text: string) => {
  const nowSec = Math.floor(Date.now() / 1000);
  const baseId = Date.now();
  return {
    update_id: baseId,
    message: {
      message_id: baseId,
      date: nowSec,
      chat: {
        id: telegramUserId,
        type: "private",
      },
      from: {
        id: telegramUserId,
        is_bot: false,
        first_name: "PINAI",
      },
      text,
    },
  };
};

const postPrivateWebhook = async (
  update: Record<string, unknown>,
): Promise<boolean> => {
  const secret = config.telegram.webhookSecret?.trim();
  if (!secret) return false;

  const baseUrl = config.publicBaseUrl.replace(/\/+$/, "");
  const urls = [
    `${baseUrl}/webhook/telegram/private`,
    `${baseUrl}/webhook/telegram`,
  ];
  const maxAttempts = 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    for (const url of urls) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Telegram-Bot-Api-Secret-Token": secret,
          },
          body: JSON.stringify(update),
        });
        if (res.ok) {
          let forwarded = false;
          try {
            const payload = (await res.json()) as { forwarded?: unknown };
            forwarded = payload.forwarded === true;
          } catch {
            forwarded = false;
          }
          if (forwarded) return true;
          console.warn("[onboarding] greeting trigger acknowledged but not forwarded", {
            url,
            attempt,
          });
          continue;
        }
        console.warn("[onboarding] greeting trigger webhook returned non-2xx", {
          url,
          attempt,
          status: res.status,
        });
      } catch (error) {
        console.warn("[onboarding] greeting trigger webhook request failed", {
          url,
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 600));
    }
  }

  return false;
};

const parseHasProfile = (metadata: Record<string, unknown>): boolean | null => {
  const value = metadata.onboarding_has_profile;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes"].includes(normalized)) return true;
    if (["0", "false", "no"].includes(normalized)) return false;
  }
  return null;
};

const readAssistantOwnerTelegramId = async (
  assistantId: number,
): Promise<number | null> => {
  const result = await pool.query<{ telegram_user_id: number }>(
    `
      SELECT u.telegram_user_id
      FROM assistants a
      INNER JOIN users u ON u.id = a.owner_user_id
      WHERE a.id = $1
      LIMIT 1
    `,
    [assistantId],
  );

  return result.rows[0]?.telegram_user_id ?? null;
};

export const triggerReadyGreetingForAssistant = async (input: {
  assistantId: number;
  telegramUserId: number;
}): Promise<boolean> => {
  const metadata = await readAssistantRuntimeMetadata(input.assistantId);
  if (!shouldTriggerReadyGreeting(metadata)) {
    return true;
  }

  let hasProfile = parseHasProfile(metadata);
  let profileText = "";

  if (hasProfile === null) {
    const ownerTelegramId =
      (await readAssistantOwnerTelegramId(input.assistantId)) ??
      input.telegramUserId;
    const profile = await resolveExternalProfileForTelegramUser(ownerTelegramId);
    hasProfile = Boolean(profile?.profileText?.trim());
    profileText = profile?.profileText || "";
  }

  const prompt = buildOnboardingGreetingPrompt({
    hasProfile: Boolean(hasProfile),
    profileText,
  });

  const update = buildPrivateWebhookUpdate(input.telegramUserId, prompt);
  const ok = await postPrivateWebhook(update);
  if (!ok) return false;

  await setAssistantRuntimeMetadataKey(
    input.assistantId,
    "onboarding_greeted_at",
    new Date().toISOString(),
  ).catch((error) => {
    console.warn("[onboarding] Failed to persist greeting metadata", {
      assistantId: input.assistantId,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  return true;
};
