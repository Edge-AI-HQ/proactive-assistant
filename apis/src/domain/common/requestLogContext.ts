import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
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

const nextTraceId = (): string => randomUUID();

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

const safeJsonStringify = (value: unknown): string => {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, raw) => {
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
  return safeJsonStringify(value);
};

const patchConsole = (): void => {
  if (consolePatched) return;
  consolePatched = true;

  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      const store = logContext.getStore();
      const finalArgs = store
        ? mergeLogMeta(args, {
            trace_id: store.traceId,
            tg_id: store.tgId ?? "n/a",
          })
        : args;
      original(formatLogLine(finalArgs));
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
  const startedAt = Date.now();
  let responseBodyPreview: unknown;

  const originalJson = res.json.bind(res);
  res.json = (body: unknown) => {
    responseBodyPreview = previewValue(body);
    return originalJson(body);
  };

  const originalSend = res.send.bind(res);
  res.send = (body: unknown) => {
    responseBodyPreview = previewValue(body);
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
      console.log("[http:out]", {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: Date.now() - startedAt,
        response: responseBodyPreview,
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

export const initializeRequestLogging = (): void => {
  patchConsole();
};
