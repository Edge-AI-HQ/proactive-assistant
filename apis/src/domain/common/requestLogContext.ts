import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestHandler } from "express";

type LogContext = {
  traceId: string;
  tgId?: string;
};

const logContext = new AsyncLocalStorage<LogContext>();
let consolePatched = false;

const toSingleHeaderValue = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
};

const nextTraceId = (): string =>
  `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const toPositiveIntString = (value: unknown): string | undefined => {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!/^\d+$/.test(raw)) return undefined;
  return raw;
};

const mergeLogMeta = (args: unknown[], meta: Record<string, unknown>): unknown[] => {
  if (args.length === 0) return [meta];
  const last = args[args.length - 1];
  if (
    last &&
    typeof last === "object" &&
    !Array.isArray(last) &&
    !(last instanceof Error)
  ) {
    const record = last as Record<string, unknown>;
    if (
      "trace_id" in record ||
      "traceId" in record ||
      "tg_id" in record ||
      "telegram_user_id" in record
    ) {
      return args;
    }
  }
  return [...args, meta];
};

const patchConsole = (): void => {
  if (consolePatched) return;
  consolePatched = true;

  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      const store = logContext.getStore();
      if (!store) {
        original(...args);
        return;
      }

      original(
        ...mergeLogMeta(args, {
          trace_id: store.traceId,
          tg_id: store.tgId ?? "n/a",
        }),
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

  const seedTgId =
    toPositiveIntString(req.params?.user_id) ??
    toPositiveIntString(req.query?.user_id) ??
    undefined;

  const context: LogContext = seedTgId ? { traceId, tgId: seedTgId } : { traceId };
  logContext.run(context, next);
};

export const setLogContextTelegramUserId = (telegramUserId: number | string): void => {
  const store = logContext.getStore();
  if (!store) return;
  store.tgId = String(telegramUserId);
};

export const initializeRequestLogging = (): void => {
  patchConsole();
};
