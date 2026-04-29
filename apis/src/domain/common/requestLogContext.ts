import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";

/**
 * Per-request log context.
 *
 * `traceId` is set by the middleware on every HTTP request. `userId` /
 * `userName` are populated lazily by domain code (e.g. requireProactiveAuth
 * after it resolves a Supabase user) so subsequent log lines can be attributed
 * back to a user without extra plumbing.
 */
type LogContext = {
  traceId: string;
  userId?: string;
  userName?: string;
};

const logContext = new AsyncLocalStorage<LogContext>();
let consolePatched = false;

const toSingleHeaderValue = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
};

const nextTraceId = (): string => randomUUID();

const previewBuffer = (buffer: Buffer): string => {
  const text = buffer.toString("utf8");
  const hasReplacement = text.includes("�");
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
      const line = formatLogLine(args);
      if (!store) {
        original(line);
        return;
      }
      original(
        `${line}|trace_id=${store.traceId}|user_id=${store.userId ?? "n/a"}|user_name=${store.userName ?? "n/a"}`,
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

  const context: LogContext = { traceId };
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
    console.info("[http:in]", {
      method: req.method,
      path: req.path,
      ip: req.ip ?? null,
      ua: toSingleHeaderValue(req.headers["user-agent"]),
      params: req.params,
      query: req.query,
    });

    res.on("finish", () => {
      logContext.run(context, () => {
        console.info("[http:out]", {
          method: req.method,
          path: req.path,
          status: res.statusCode,
          duration_ms: Date.now() - startedAt,
          ...(responseBodyPreview !== undefined ? { response: responseBodyPreview } : {}),
        });
      });
    });

    next();
  });
};

export const setLogContextUserId = (userId: number | string): void => {
  const store = logContext.getStore();
  if (!store) return;
  store.userId = String(userId);
};

export const setLogContextUsername = (username: string | null | undefined): void => {
  const store = logContext.getStore();
  if (!store) return;
  if (typeof username !== "string") return;
  const normalized = username.trim().replace(/^@+/, "");
  if (!normalized) return;
  store.userName = normalized;
};

export const setLogContextIdentity = (
  userId: number | string | null | undefined,
  username?: string | null,
): void => {
  if (userId !== null && userId !== undefined && String(userId).trim()) {
    setLogContextUserId(userId);
  }
  if (username !== undefined) {
    setLogContextUsername(username);
  }
};

export const initializeRequestLogging = (): void => {
  patchConsole();
};
