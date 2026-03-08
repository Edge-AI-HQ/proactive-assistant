import { pool } from "../common/db/core.js";
import {
  setAssistantRuntimeMetadataKeyIfAbsent,
  setAssistantRuntimeMetadataKey,
} from "../common/db/runtimeRepository.js";
import { config } from "../common/config.js";
import {
  buildOnboardingGreetingPrompt,
  resolveExternalProfileForTelegramUser,
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

const buildReadyGreetingWebhookUrls = (baseUrl: string): string[] => [
  `${baseUrl.replace(/\/+$/, "")}/webhook/telegram/private`,
];

const READY_GREETING_MAX_ATTEMPTS = 10;

const buildReadyGreetingRetryDelayMs = (attempt: number): number =>
  Math.min(1500 * attempt, 4000);

export const buildReadyGreetingWebhookUrlsForTest = (baseUrl: string): string[] =>
  buildReadyGreetingWebhookUrls(baseUrl);

export const buildReadyGreetingRetryDelaysForTest = (): number[] =>
  Array.from({ length: Math.max(READY_GREETING_MAX_ATTEMPTS - 1, 0) }, (_, index) =>
    buildReadyGreetingRetryDelayMs(index + 1),
  );

export const buildReadyGreetingFallbackMessage = (): string =>
  [
    "Hey, I’m online now.",
    "",
    "Tell me what you want to work on first.",
  ].join("\n");

const postPrivateWebhook = async (
  update: Record<string, unknown>,
): Promise<boolean> => {
  const secret = config.telegram.webhookSecret?.trim();
  if (!secret) return false;

  const baseUrl = config.publicBaseUrl.replace(/\/+$/, "");
  const urls = buildReadyGreetingWebhookUrls(baseUrl);
  const maxAttempts = READY_GREETING_MAX_ATTEMPTS;

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
      await new Promise((resolve) => setTimeout(resolve, buildReadyGreetingRetryDelayMs(attempt)));
    }
  }

  return false;
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
  const claimed = await setAssistantRuntimeMetadataKeyIfAbsent(
    input.assistantId,
    "onboarding_greeted_at",
    new Date().toISOString(),
  );
  if (!claimed) {
    return true;
  }

  let hasProfile: boolean | null = null;
  let profileText = "";
  let membershipDays: number | null = null;
  let membershipSinceDate: string | null = null;

  const ownerTelegramId =
    (await readAssistantOwnerTelegramId(input.assistantId)) ??
    input.telegramUserId;
  const profile = await resolveExternalProfileForTelegramUser(ownerTelegramId);
  hasProfile = Boolean(profile?.profileText?.trim());
  profileText = profile?.profileText || "";
  if (profile?.accountCreatedAt) {
    const createdAt = new Date(profile.accountCreatedAt);
    const createdAtMs = createdAt.getTime();
    if (Number.isFinite(createdAtMs)) {
      const diffDays = Math.floor((Date.now() - createdAtMs) / 86_400_000);
      membershipDays = Math.max(1, diffDays);
      membershipSinceDate = createdAt.toISOString().slice(0, 10);
    }
  }

  const prompt = buildOnboardingGreetingPrompt({
    hasProfile: Boolean(hasProfile),
    profileText,
    membershipDays,
    membershipSinceDate,
  });

  const update = buildPrivateWebhookUpdate(input.telegramUserId, prompt);
  const ok = await postPrivateWebhook(update);
  if (!ok) {
    await setAssistantRuntimeMetadataKey(
      input.assistantId,
      "onboarding_greeted_at",
      null,
    ).catch((error) => {
      console.warn("[onboarding] Failed to clear greeting metadata after delivery failure", {
        assistantId: input.assistantId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return false;
  }

  return true;
};
