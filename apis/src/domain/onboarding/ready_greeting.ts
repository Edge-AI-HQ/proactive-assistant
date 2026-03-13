import {
  readAssistantRuntimeMetadata,
  setAssistantRuntimeMetadataKey,
  setAssistantRuntimeMetadataKeyIfAbsent,
} from "../common/db/runtimeRepository.js";
import {
  resolveExternalProfileForTelegramUser,
  type ProfileCandidate,
} from "./profile_bootstrap.js";
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

const normalizeDateLike = (value: unknown): string => {
  if (typeof value === "string") return value.trim();
  if (value instanceof Date) {
    const ms = value.getTime();
    if (!Number.isFinite(ms)) return "";
    return value.toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return "";
};

const pickEarlierIsoDate = (
  a: unknown,
  b: unknown,
): string | null => {
  const first = normalizeDateLike(a);
  const second = normalizeDateLike(b);
  if (!first) return second || null;
  if (!second) return first;
  const firstMs = new Date(first).getTime();
  const secondMs = new Date(second).getTime();
  if (!Number.isFinite(firstMs)) return second;
  if (!Number.isFinite(secondMs)) return first;
  return firstMs <= secondMs ? first : second;
};

const resolveMySqlJoinDate = (
  externalProfile: ProfileCandidate | null,
): string | null => {
  const joinDate = normalizeDateLike(externalProfile?.accountCreatedAt ?? null);
  return joinDate || null;
};

const shouldSendApiReadyGreeting = (
  input: Pick<ReadyGreetingRenderInput, "joinDate" | "daysWithPinai">,
): boolean => Boolean(input.joinDate) && typeof input.daysWithPinai === "number";

export const buildApiReadyGreetingMessage = (
  input: ReadyGreetingRenderInput,
): string => {
  const joined = formatJoinDate(input.joinDate, input.locale);

  if (input.locale === "zh") {
    const lines: string[] = ["👋 我是 PIN Claw。", ""];

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
    lines.push("✨ 今天想先处理什么？");
    return lines.join("\n");
  }

  const lines: string[] = ["👋 Hi, I'm PIN Claw.", ""];
  if (input.subscriptionActive) {
    lines.push("💎 Thanks for staying with PINAI.");
  } else {
    lines.push("💎 Welcome back to PINAI.");
  }

  if (joined && input.daysWithPinai) {
    lines.push(
      `📅 You've been with PINAI since ${joined} — ${input.daysWithPinai} ${formatEnglishDayLabel(input.daysWithPinai)}.`,
    );
  } else if (input.daysWithPinai) {
    lines.push(
      `📅 You've been with PINAI for ${input.daysWithPinai} ${formatEnglishDayLabel(input.daysWithPinai)}.`,
    );
  }

  lines.push("");
  lines.push("Before we start, two quick things:");
  if (input.askPreferredName) {
    lines.push("• What should I call you?");
  } else {
    lines.push("• If you'd like a different nickname, tell me anytime.");
  }
  lines.push("• Do you prefer concise answers or detailed ones?");
  lines.push("✨ What would you like to work on first?");
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
  const [runtimeMetadata, subscriptionActive, externalProfile] = await Promise.all([
    readAssistantRuntimeMetadata(assistantId).catch(() => ({})),
    hasActiveSubscriptionForService(String(telegramUserId)).catch(() => false),
    resolveExternalProfileForTelegramUser(telegramUserId).catch(() => null),
  ]);

  const joinDate = resolveMySqlJoinDate(externalProfile);
  const daysWithPinai = computeDaysWithPinai(joinDate);
  const metadataRecord = runtimeMetadata as Record<string, unknown>;
  const languageCode =
    typeof metadataRecord["telegram_language_code"] === "string"
      ? String(metadataRecord["telegram_language_code"])
      : null;
  const locale = resolveLocale(languageCode);
  console.info("[onboarding] PIN Claw greeting context resolved", {
    assistantId,
    telegramUserId,
    profileMatched: Boolean(externalProfile),
    profileSource: externalProfile?.source ?? null,
    externalUserId: externalProfile?.externalUserId ?? null,
    mysqlAccountCreatedAt: externalProfile?.accountCreatedAt ?? null,
    joinDate,
    daysWithPinai,
    locale,
  });

  return {
    locale,
    subscriptionActive,
    joinDate,
    daysWithPinai,
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
    console.info("[onboarding] PIN Claw greeting skipped: lock already claimed", {
      assistantId: input.assistantId,
      telegramUserId: input.telegramUserId,
    });
    return true;
  }

  const greetingContext = await resolveGreetingContext(
    input.assistantId,
    input.telegramUserId,
  );
  if (!shouldSendApiReadyGreeting(greetingContext)) {
    console.info("[onboarding] PIN Claw greeting skipped: missing MySQL join date", {
      assistantId: input.assistantId,
      telegramUserId: input.telegramUserId,
      joinDate: greetingContext.joinDate,
      daysWithPinai: greetingContext.daysWithPinai,
    });
    return true;
  }
  const message = buildApiReadyGreetingMessage(greetingContext);

  try {
    const sent = await sendTelegramMessage(input.telegramUserId, message);
    if (!sent.ok) {
      throw new Error(sent.error || "sendTelegramMessage returned ok=false");
    }
    console.info("[onboarding] PIN Claw greeting sent", {
      assistantId: input.assistantId,
      telegramUserId: input.telegramUserId,
      joinDate: greetingContext.joinDate,
      daysWithPinai: greetingContext.daysWithPinai,
      locale: greetingContext.locale,
    });
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
export const pickEarlierIsoDateForTest = pickEarlierIsoDate;
export const resolveMySqlJoinDateForTest = resolveMySqlJoinDate;
export const shouldSendApiReadyGreetingForTest = (
  input: { joinDate: string | null },
): boolean =>
  shouldSendApiReadyGreeting({
    joinDate: input.joinDate,
    daysWithPinai: computeDaysWithPinai(input.joinDate),
  });
