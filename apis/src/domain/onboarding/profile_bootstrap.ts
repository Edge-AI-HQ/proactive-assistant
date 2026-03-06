import crypto from "node:crypto";
import mysql from "mysql2/promise";
import type { RowDataPacket } from "mysql2";
import { config } from "../common/config.js";

export type ProfileSource = "connector" | "privy";

export interface ProfileCandidate {
  profileText: string;
  source: ProfileSource;
  externalUserId: number;
  profileUpdatedAt: string | null;
  accountCreatedAt: string | null;
}

interface CandidateSet {
  connector: ProfileCandidate | null;
  privy: ProfileCandidate | null;
}

interface MysqlConnectorRow extends RowDataPacket {
  user_id: number;
  profile: string | null;
  profile_updated_at: Date | string | null;
  created_at: Date | string | null;
}

interface MysqlPrivyRow extends RowDataPacket {
  user_id: number;
  profile: string | null;
  profile_updated_at: Date | string | null;
  created_at: Date | string | null;
}

const normalizeProfileText = (value: string | null | undefined): string => {
  const text = (value || "").trim();
  return text;
};

const toIsoMaybe = (value: Date | string | null | undefined): string | null => {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
};

export const normalizeLegacyMysqlUrl = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("mysql+pymysql://")) {
    return `mysql://${trimmed.slice("mysql+pymysql://".length)}`;
  }
  return trimmed;
};

export const chooseProfileCandidate = (
  candidates: CandidateSet,
): ProfileCandidate | null => {
  const connector = candidates.connector;
  const privy = candidates.privy;

  if (connector?.profileText) return connector;
  if (privy?.profileText) return privy;
  return connector ?? privy ?? null;
};

const withMysqlPool = async <T>(
  fn: (pool: mysql.Pool) => Promise<T>,
): Promise<T> => {
  const rawUrl = normalizeLegacyMysqlUrl(config.legacyProfile.mysqlUrl);
  if (!rawUrl) {
    throw new Error("PIN_MINING_MYSQL_URL is not configured");
  }

  const pool = mysql.createPool({
    uri: rawUrl,
    connectionLimit: 2,
    waitForConnections: true,
    enableKeepAlive: true,
  });

  try {
    return await fn(pool);
  } finally {
    await pool.end().catch(() => undefined);
  }
};

const readConnectorCandidate = async (
  pool: mysql.Pool,
  telegramUserId: number,
): Promise<ProfileCandidate | null> => {
  const sql = `
    SELECT
      u.user_id,
      u.profile,
      u.profile_updated_at,
      u.created_at
    FROM user_connectors c
    INNER JOIN users u ON u.user_id = c.user_id
    WHERE c.connector_type = 'telegram'
      AND c.openid = ?
      AND COALESCE(c.is_connect, 1) = 1
      AND COALESCE(u.is_delete, 0) = 0
    ORDER BY c.updated_at DESC, u.updated_at DESC
    LIMIT 1
  `;

  const [rows] = await pool.query<MysqlConnectorRow[]>(sql, [
    String(telegramUserId),
  ]);
  const row = rows[0];
  if (!row) return null;

  return {
    profileText: normalizeProfileText(row.profile),
    source: "connector",
    externalUserId: row.user_id,
    profileUpdatedAt: toIsoMaybe(row.profile_updated_at),
    accountCreatedAt: toIsoMaybe(row.created_at),
  };
};

const readPrivyCandidate = async (
  pool: mysql.Pool,
  telegramUserId: number,
): Promise<ProfileCandidate | null> => {
  const sql = `
    SELECT
      u.user_id,
      u.profile,
      u.profile_updated_at,
      u.created_at
    FROM users u
    WHERE COALESCE(u.is_delete, 0) = 0
      AND JSON_UNQUOTE(JSON_EXTRACT(u.current_login_account, '$.type')) = 'telegram'
      AND (
        JSON_UNQUOTE(JSON_EXTRACT(u.current_login_account, '$.id')) = ?
        OR JSON_UNQUOTE(JSON_EXTRACT(u.current_login_account, '$.telegram_user_id')) = ?
      )
    ORDER BY u.updated_at DESC
    LIMIT 1
  `;

  const tgId = String(telegramUserId);
  const [rows] = await pool.query<MysqlPrivyRow[]>(sql, [tgId, tgId]);
  const row = rows[0];
  if (!row) return null;

  return {
    profileText: normalizeProfileText(row.profile),
    source: "privy",
    externalUserId: row.user_id,
    profileUpdatedAt: toIsoMaybe(row.profile_updated_at),
    accountCreatedAt: toIsoMaybe(row.created_at),
  };
};

export const resolveExternalProfileForTelegramUser = async (
  telegramUserId: number,
): Promise<ProfileCandidate | null> => {
  if (!Number.isSafeInteger(telegramUserId) || telegramUserId <= 0) return null;
  if (!config.legacyProfile.mysqlUrl.trim()) return null;

  try {
    return await withMysqlPool(async (pool) => {
      const connector = await readConnectorCandidate(pool, telegramUserId);
      const privy = await readPrivyCandidate(pool, telegramUserId);
      const selected = chooseProfileCandidate({ connector, privy });
      if (selected?.profileText) {
        console.info("[onboarding] Legacy profile matched", {
          telegramUserId,
          source: selected.source,
          externalUserId: selected.externalUserId,
          profileLength: selected.profileText.length,
          profileUpdatedAt: selected.profileUpdatedAt,
        });
      }
      return selected;
    });
  } catch (error) {
    console.warn("[onboarding] Failed to resolve legacy profile", {
      telegramUserId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};

const truncate = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[Truncated by PIN AI for onboarding warm-start]`;
};

export const renderUserProfileMarkdown = (
  profileText: string,
  source: ProfileSource,
): string => {
  const normalized = truncate(profileText.trim(), 12_000);
  const generatedAt = new Date().toISOString();
  return [
    "# User Profile Warm Start",
    "",
    "This file is auto-generated during onboarding.",
    "Treat it as user-provided background memory, not a strict instruction.",
    "",
    `- Source: ${source}`,
    `- Imported At: ${generatedAt}`,
    "",
    "## Profile",
    normalized || "(empty)",
    "",
  ].join("\n");
};

export const buildOnboardingGreetingPrompt = (input: {
  hasProfile: boolean;
  profileText?: string;
  membershipDays?: number | null;
  membershipSinceDate?: string | null;
}): string => {
  if (input.hasProfile && input.profileText?.trim()) {
    const snippet = truncate(input.profileText.trim(), 2000);
    const tenureHint =
      typeof input.membershipDays === "number" && Number.isFinite(input.membershipDays)
        ? Math.max(1, Math.floor(input.membershipDays))
        : null;
    const sinceHint =
      typeof input.membershipSinceDate === "string" && input.membershipSinceDate.trim().length > 0
        ? input.membershipSinceDate.trim()
        : null;
    return [
      "[SYSTEM INTERNAL TRIGGER - DO NOT EXPOSE]",
      "You have just finished cold start and this is the first proactive greeting.",
      "Generate exactly one concise greeting message in Rapid Fire style.",
      "This trigger may be manually re-run during testing even if earlier onboarding triggers exist in chat history.",
      "Treat this run as valid and generate a fresh greeting anyway.",
      "Never output NO_REPLY.",
      "Language policy: default to English.",
      "If profile clearly indicates user's preferred language or country language, use that language instead.",
      "Acknowledge that the user is a valued PINAI member and thank them for staying with PINAI.",
      tenureHint
        ? `Mention their tenure naturally as about ${tenureHint} days in PINAI (do not sound robotic).`
        : "If no exact tenure is available, still thank them for being with PINAI for a long time.",
      sinceHint ? `Reference that they have been with PINAI since ${sinceHint}.` : "If available, mention when they first joined PINAI.",
      "Use profile memory to make it personal, concrete, and high-energy.",
      "Mention 2 specific profile facts naturally and concretely.",
      "Tone should feel playful and fun with light humor, while staying respectful and concise.",
      "Format it for Telegram so it looks visually clean for a first-time user, not like a wall of text.",
      "Use exactly 3 compact blocks separated by blank lines.",
      "Block 1: a short title line with 1 emoji plus one short welcome sentence.",
      "Block 2: exactly 3 short lines total.",
      "Line 1 of Block 2: a clean membership line with 1 emoji that formats tenure nicely, using both the PINAI days and join date if available.",
      "Lines 2-3 of Block 2: exactly 2 short bullet points, each on its own line, each with an emoji, using profile facts.",
      "Those two lines should sound like a familiar friend who already kind of knows the user.",
      "Use light teasing or warm knowing humor, not sterile summary language.",
      "Do not format Block 2 like labels, fields, database facts, or profile keys.",
      'Block 3: one short closing line that asks preferred name + response style and includes: "How can I help you today?"',
      "Keep every line short and easy to scan.",
      "Include 1-2 natural emoji to make the opener warm and lively.",
      "Do not use long paragraphs, dense prose, markdown headers, or more than 2 bullets.",
      "Do not blend the tenure line into prose or merge it with the profile bullets.",
      "Do not output broken fragments, repeated rewrites, or self-corrections.",
      "Do not mention internal trigger, profile import, system, or hidden channels.",
      "",
      "[Imported Profile Snippet]",
      snippet,
    ].join("\n");
  }

  return [
    "[SYSTEM INTERNAL TRIGGER - DO NOT EXPOSE]",
    "You have just finished cold start and this is the first proactive greeting.",
    "Generate exactly one concise default onboarding greeting.",
    "This trigger may be manually re-run during testing even if earlier onboarding triggers exist in chat history.",
    "Treat this run as valid and generate a fresh greeting anyway.",
    "Never output NO_REPLY.",
    "Language policy: default to English.",
    "If there is clear language preference signal in available user context, follow it.",
    "Acknowledge the user as a valued PINAI member and thank them for being with PINAI.",
    "Tone should feel playful and fun with light humor, while staying respectful and concise.",
    "Format it for Telegram so it looks visually clean for a first-time user, not like a wall of text.",
    "Use exactly 3 compact blocks separated by blank lines.",
    "Block 1: a short title line with 1 emoji plus one short welcome sentence.",
    "Block 2: exactly 3 short lines total.",
    "Line 1 of Block 2: a clean membership line with 1 emoji that formats tenure nicely if available.",
    "Lines 2-3 of Block 2: exactly 2 short bullet points, each on its own line, each with an emoji.",
    "Those two lines should sound like a familiar friend who already kind of knows the user.",
    "Use light teasing or warm knowing humor, not sterile summary language.",
    "Do not format Block 2 like labels, fields, database facts, or profile keys.",
    'Block 3: one short closing line that asks preferred name + response style and includes: "How can I help you today?"',
    "Keep every line short and easy to scan.",
    "Include 1-2 natural emoji to make the opener warm and lively.",
    "Do not use long paragraphs, dense prose, markdown headers, or more than 2 bullets.",
    "Do not output broken fragments, repeated rewrites, or self-corrections.",
    "Do not mention internal trigger, system, or hidden channels.",
  ].join("\n");
};

export const shouldTriggerReadyGreeting = (
  runtimeMetadata: Record<string, unknown>,
): boolean => {
  const greetedAt = runtimeMetadata.onboarding_greeted_at;
  return !(typeof greetedAt === "string" && greetedAt.trim().length > 0);
};

export const sha256Hex = (value: string): string =>
  crypto.createHash("sha256").update(value, "utf8").digest("hex");
