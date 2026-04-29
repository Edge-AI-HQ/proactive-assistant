import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { Request, RequestHandler } from "express";

type LogContext = {
  traceId: string;
  tgId?: string;
  tgName?: string;
};

const logContext = new AsyncLocalStorage<LogContext>();
let consolePatched = false;

const toSingleHeaderValue = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
};

const nextTraceId = (): string => randomUUID();

const toPositiveIntString = (value: unknown): string | undefined => {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  const raw = typeof value === "string" ? value.trim() : "";
  if (!/^\d+$/.test(raw)) return undefined;
  return raw;
};

const toTelegramUsername = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/^@+/, "");
  if (!normalized) return undefined;
  return normalized;
};

const buildIdentity = (
  tgId?: string,
  tgName?: string,
): { tgId?: string; tgName?: string } => ({
  ...(tgId ? { tgId } : {}),
  ...(tgName ? { tgName } : {}),
});

const readTelegramIdentityFromInitData = (
  value: unknown,
): { tgId?: string; tgName?: string } => {
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const params = new URLSearchParams(value.trim());
    const userRaw = params.get("user");
    if (!userRaw) return {};
    const parsed = JSON.parse(userRaw) as { id?: unknown; username?: unknown };
    return buildIdentity(
      toPositiveIntString(parsed.id),
      toTelegramUsername(parsed.username),
    );
  } catch {
    return {};
  }
};

const readTelegramIdentityFromRecord = (
  value: unknown,
): { tgId?: string; tgName?: string } => {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;

  const directKeys = [
    "telegram_user_id",
    "telegramUserId",
    "tg_id",
    "tgId",
    "user_id",
    "userId",
    "provider_user_id",
    "providerUserId",
    "chat_id",
    "chatId",
    "from_id",
    "fromId",
  ] as const;
  let tgId: string | undefined;
  for (const key of directKeys) {
    const found = toPositiveIntString(record[key]);
    if (found) {
      tgId = found;
      break;
    }
  }

  const usernameKeys = [
    "telegram_username",
    "telegramUsername",
    "username",
    "user_name",
    "tg_name",
    "tgName",
  ] as const;
  let tgName: string | undefined;
  for (const key of usernameKeys) {
    const found = toTelegramUsername(record[key]);
    if (found) {
      tgName = found;
      break;
    }
  }

  const fromNested = [record.user, record.from, record.chat, record.sender];
  for (const nested of fromNested) {
    if (nested && typeof nested === "object") {
      const nestedRecord = nested as Record<string, unknown>;
      tgId = tgId ?? toPositiveIntString(nestedRecord.id);
      tgName = tgName ?? toTelegramUsername(nestedRecord.username);
      if (tgId && tgName) break;
    }
  }

  const fromInitData = readTelegramIdentityFromInitData(
    record.init_data ?? record.initData,
  );
  tgId = tgId ?? fromInitData.tgId;
  tgName = tgName ?? fromInitData.tgName;

  return buildIdentity(tgId, tgName);
};

const readTelegramIdentityFromRequest = (
  req: Request,
): { tgId?: string; tgName?: string } => {
  const headerCandidates = [
    req.headers["x-telegram-user-id"],
    req.headers["x-telegram-userid"],
    req.headers["x-tg-id"],
  ];
  let tgId: string | undefined;
  for (const candidate of headerCandidates) {
    const found = toPositiveIntString(toSingleHeaderValue(candidate));
    if (found) {
      tgId = found;
      break;
    }
  }
  const tgName = toTelegramUsername(
    toSingleHeaderValue(req.headers["x-telegram-username"]) ??
      toSingleHeaderValue(req.headers["x-tg-name"]),
  );

  const recordCandidates = [req.params, req.query, req.body];
  for (const candidate of recordCandidates) {
    const found = readTelegramIdentityFromRecord(candidate);
    tgId = tgId ?? found?.tgId;
    if (!found?.tgName) continue;
    return buildIdentity(tgId, tgName ?? found.tgName);
  }

  return buildIdentity(tgId, tgName);
};

const previewBuffer = (buffer: Buffer): string => {
  const text = buffer.toString("utf8");
  const hasReplacement = text.includes("\uFFFD");
  if (!hasReplacement) return text;
  return JSON.stringify({
    type: "buffer",
    encoding: "base64",
    data: buffer.toString("base64"),
  });
};

// Keys that must NEVER appear plaintext in logs. Match is case-insensitive
// and exact (no substring) so a benign field like "tokens_used" still
// passes through. Add to this set when introducing a new secret-bearing
// response field; do not loosen the existing entries.
const SENSITIVE_LOG_KEYS = new Set([
  "device_token",
  "device_token_temp",
  "deviceToken",
  "access_token",
  "accessToken",
  "refresh_token",
  "refreshToken",
  "authorization",
  "Authorization",
  "x-device-token",
  "X-Device-Token",
  "supabase_jwt",
  "password",
  "secret",
]);

const safeJsonStringify = (value: unknown): string => {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (key, raw) => {
    // Redact sensitive values before any other handling so we never
    // accidentally serialise plaintext credentials.
    if (typeof key === "string" && SENSITIVE_LOG_KEYS.has(key) && raw != null) {
      return "[REDACTED]";
    }
    if (typeof raw === "bigint") return raw.toString();
    if (Buffer.isBuffer(raw)) return previewBuffer(raw);
    if (raw instanceof Error) {
      return {
        name: raw.name,
        message: raw.message,
        stack: raw.stack?.replace(/\n/g, "\\n"),
      };
    }
    if (raw && typeof raw === "object") {
      const asObject = raw as object;
      if (seen.has(asObject)) return "[Circular]";
      seen.add(asObject);
    }
    if (typeof raw === "string") return raw.replace(/\n/g, "\\n");
    return raw;
  });
};

const toOneLineString = (arg: unknown): string => {
  if (typeof arg === "string") return arg.replace(/\n/g, "\\n");
  return safeJsonStringify(arg);
};

const formatLogLine = (args: unknown[]): string =>
  args.map((arg) => toOneLineString(arg)).join(" ");

const previewValue = (value: unknown): unknown => {
  if (value === undefined) return undefined;
  if (Buffer.isBuffer(value)) return previewBuffer(value);
  if (typeof value === "string") return value;
  // Return the object as-is so the outer log stringification walks
  // every nested key through safeJsonStringify's replacer (which redacts
  // SENSITIVE_LOG_KEYS). Pre-stringifying here would freeze the JSON
  // into a string that the replacer can no longer reach.
  return value;
};

const patchConsole = (): void => {
  if (consolePatched) return;
  consolePatched = true;

  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      const store = logContext.getStore();
      const line = formatLogLine(args);
      if (!store) {
        original(line);
        return;
      }
      original(
        `${line}|trace_id=${store.traceId}|tg_id=${store.tgId ?? "n/a"}|tg_name=${store.tgName ?? "n/a"}`,
      );
    };
  }
};

export const requestLogContextMiddleware: RequestHandler = (req, res, next) => {
  const incomingTrace =
    toSingleHeaderValue(req.headers["x-request-id"]) ??
    toSingleHeaderValue(req.headers["x-trace-id"]);
  const traceId = incomingTrace?.trim() || nextTraceId();
  res.setHeader("x-trace-id", traceId);

  const seedIdentity = readTelegramIdentityFromRequest(req);

  const context: LogContext = {
    traceId,
    ...(seedIdentity.tgId ? { tgId: seedIdentity.tgId } : {}),
    ...(seedIdentity.tgName ? { tgName: seedIdentity.tgName } : {}),
  };
  const startedAt = Date.now();
  let responseBodyPreview: unknown;
  // Express implements res.json by stringifying the body and calling
  // res.send internally — that means res.send fires AFTER res.json, with
  // an already-stringified blob. We want the structured object res.json
  // saw (so the redacting JSON replacer can walk it), so we lock the
  // preview to the first capture and let res.send only fill in for
  // routes that bypass res.json.
  let previewLocked = false;

  const originalJson = res.json.bind(res);
  res.json = (body: unknown) => {
    if (!previewLocked) {
      responseBodyPreview = previewValue(body);
      previewLocked = true;
    }
    return originalJson(body);
  };

  const originalSend = res.send.bind(res);
  res.send = (body: unknown) => {
    if (!previewLocked) {
      responseBodyPreview = previewValue(body);
      previewLocked = true;
    }
    return originalSend(body);
  };

  logContext.run(context, () => {
    console.log("[http:in]", {
      method: req.method,
      path: req.path,
      ip: req.ip,
      ua: req.get("user-agent") ?? "",
      params: req.params,
      query: req.query,
      body: previewValue(req.body),
    });

    res.on("finish", () => {
      // Truncate large response bodies (e.g. HTML pages) to keep logs readable
      const MAX_RESPONSE_LOG = 512;
      let preview = responseBodyPreview;
      if (typeof preview === "string" && preview.length > MAX_RESPONSE_LOG) {
        preview = `${preview.slice(0, MAX_RESPONSE_LOG)}…[truncated ${preview.length} chars]`;
      }
      console.log("[http:out]", {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: Date.now() - startedAt,
        response: preview,
      });
    });

    res.on("close", () => {
      if (res.writableEnded) return;
      console.warn("[http:out]", {
        method: req.method,
        path: req.path,
        status: "closed",
        duration_ms: Date.now() - startedAt,
      });
    });

    next();
  });
};

export const setLogContextTelegramUserId = (telegramUserId: number | string): void => {
  const store = logContext.getStore();
  if (!store) return;
  store.tgId = String(telegramUserId);
};

export const setLogContextTelegramUsername = (telegramUsername: string | null | undefined): void => {
  const store = logContext.getStore();
  if (!store) return;
  const normalized = toTelegramUsername(telegramUsername);
  if (!normalized) return;
  store.tgName = normalized;
};

export const setLogContextTelegramIdentity = (
  telegramUserId: number | string | null | undefined,
  telegramUsername?: string | null,
): void => {
  if (telegramUserId !== null && telegramUserId !== undefined && String(telegramUserId).trim()) {
    setLogContextTelegramUserId(telegramUserId);
  }
  if (telegramUsername !== undefined) {
    setLogContextTelegramUsername(telegramUsername);
  }
};

export const initializeRequestLogging = (): void => {
  patchConsole();
};
