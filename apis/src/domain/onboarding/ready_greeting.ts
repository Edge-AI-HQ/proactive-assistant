import { getUserByTelegramId } from "../common/db/userRepository.js";
import {
  readAssistantRuntimeMetadata,
  setAssistantRuntimeMetadataKey,
  setAssistantRuntimeMetadataKeyIfAbsent,
} from "../common/db/runtimeRepository.js";
import { hasActiveSubscriptionForService } from "../payment/subscriptionGuard.js";
import { sendTelegramMessage } from "../telegram/notify.js";

const MS_PER_DAY = 86_400_000;

type ReadyGreetingLocale = "en" | "zh";

interface ReadyGreetingRenderInput {
  locale: ReadyGreetingLocale;
  subscriptionActive: boolean;
  joinDate: string | null;
  daysWithPinai: number | null;
  askPreferredName: boolean;
}

const formatJoinDate = (value: string | null, locale: ReadyGreetingLocale): string | null => {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  if (locale === "zh") return date.toISOString().slice(0, 10);
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
};

const resolveLocale = (languageCode: string | null | undefined): ReadyGreetingLocale => {
  const raw = String(languageCode || "").trim().toLowerCase();
  if (raw.startsWith("zh")) return "zh";
  return "en";
};

const computeDaysWithPinai = (joinDate: string | null): number | null => {
  if (!joinDate) return null;
  const joinedAt = new Date(joinDate);
  const joinedMs = joinedAt.getTime();
  if (!Number.isFinite(joinedMs)) return null;
  return Math.max(1, Math.floor((Date.now() - joinedMs) / MS_PER_DAY));
};

const formatEnglishDayLabel = (days: number): string =>
  days === 1 ? "day" : "days";

export const buildApiReadyGreetingMessage = (
  input: ReadyGreetingRenderInput,
): string => {
  const joined = formatJoinDate(input.joinDate, input.locale);

  if (input.locale === "zh") {
    const lines: string[] = ["👋 我上线啦。", ""];

    if (input.subscriptionActive) {
      lines.push("💎 你好，感谢你一直陪伴 PINAI。");
    } else {
      lines.push("💎 欢迎回来，感谢你使用 PINAI。");
    }

    if (joined && input.daysWithPinai) {
      lines.push(`📅 你从 ${joined} 加入 PINAI，到现在已经 ${input.daysWithPinai} 天了。`);
    } else if (input.daysWithPinai) {
      lines.push(`📅 你已经和 PINAI 一起走过 ${input.daysWithPinai} 天了。`);
    }

    lines.push("");
    lines.push("开始前先确认两件事：");
    if (input.askPreferredName) {
      lines.push("• 我该怎么称呼你？");
    } else {
      lines.push("• 如果你希望我换个称呼，直接告诉我。");
    }
    lines.push("• 你希望我回答时更简洁，还是更详细？");
    lines.push("");
    lines.push("✨ 今天想先处理什么？");
    return lines.join("\n");
  }

  const lines: string[] = ["👋 Hey, I’m online now.", ""];
  if (input.subscriptionActive) {
    lines.push("💎 Hi, thank you for staying with PINAI.");
  } else {
    lines.push("💎 Welcome back, and thanks for being with PINAI.");
  }

  if (joined && input.daysWithPinai) {
    lines.push(
      `📅 You joined PINAI on ${joined}, and it's been ${input.daysWithPinai} ${formatEnglishDayLabel(input.daysWithPinai)} together.`,
    );
  } else if (input.daysWithPinai) {
    lines.push(
      `📅 You’ve been with PINAI for ${input.daysWithPinai} ${formatEnglishDayLabel(input.daysWithPinai)}.`,
    );
  }

  lines.push("");
  lines.push("Quick check before we start:");
  if (input.askPreferredName) {
    lines.push("• What should I call you?");
  } else {
    lines.push("• If you want me to use a different name, just tell me.");
  }
  lines.push("• Do you want me to be concise or detailed?");
  lines.push("");
  lines.push("✨ How can I help you today?");
  return lines.join("\n");
};

export const buildReadyGreetingFallbackMessage = (): string =>
  buildApiReadyGreetingMessage({
    locale: "en",
    subscriptionActive: false,
    joinDate: null,
    daysWithPinai: null,
    askPreferredName: true,
  });

const resolveGreetingContext = async (assistantId: number, telegramUserId: number) => {
  const [user, runtimeMetadata, subscriptionActive] = await Promise.all([
    getUserByTelegramId(telegramUserId),
    readAssistantRuntimeMetadata(assistantId).catch(() => ({})),
    hasActiveSubscriptionForService(String(telegramUserId)).catch(() => false),
  ]);

  const joinDate = user?.created_at ?? null;
  const metadataRecord = runtimeMetadata as Record<string, unknown>;
  const languageCode =
    typeof metadataRecord["telegram_language_code"] === "string"
      ? String(metadataRecord["telegram_language_code"])
      : null;

  return {
    locale: resolveLocale(languageCode),
    subscriptionActive,
    joinDate,
    daysWithPinai: computeDaysWithPinai(joinDate),
    askPreferredName: true,
  } satisfies ReadyGreetingRenderInput;
};

export const sendApiReadyGreetingForAssistant = async (input: {
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

  const message = buildApiReadyGreetingMessage(
    await resolveGreetingContext(input.assistantId, input.telegramUserId),
  );

  try {
    await sendTelegramMessage(input.telegramUserId, message);
    return true;
  } catch (error) {
    await setAssistantRuntimeMetadataKey(
      input.assistantId,
      "onboarding_greeted_at",
      null,
    ).catch(() => undefined);
    console.warn("[onboarding] Failed to send API-controlled ready greeting", {
      assistantId: input.assistantId,
      telegramUserId: input.telegramUserId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
};

export const setAssistantReadyGreetingLanguageCode = async (
  assistantId: number,
  languageCode: string | null | undefined,
): Promise<void> => {
  const normalized = String(languageCode || "").trim().toLowerCase();
  if (!normalized) return;
  await setAssistantRuntimeMetadataKey(
    assistantId,
    "telegram_language_code",
    normalized,
  );
};

export const resolveReadyGreetingLocaleForTest = resolveLocale;
export const computeDaysWithPinaiForTest = computeDaysWithPinai;
