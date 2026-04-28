import WebSocket from "ws";
import type { GatewayTarget } from "../container/contracts.js";
import { gatewayHostHeaders } from "../container/contracts.js";
import {
  GATEWAY_CLIENT_ID,
  GATEWAY_CLIENT_ROLE,
  GATEWAY_CLIENT_SCOPES,
} from "./gateway_constants.js";
// ---------------------------------------------------------------------------
// Gateway WebSocket RPC client
//
// Connects to the OpenClaw gateway via WebSocket, performs the `connect`
// handshake as operator with token auth, then issues a single RPC request
// and returns the result.
// ---------------------------------------------------------------------------

const READ_RPC_TIMEOUT_MS = 10_000;
const PATCH_RPC_TIMEOUT_MS = 30_000;

/**
 * Bounded retry for `rpcCall`. Container cold start can leave the gateway
 * unable to accept new WebSockets for a few seconds — the first call after
 * login almost always 502s without retry. Only handshake-stage failures are
 * retried (see {@link rpcCallOnce}); post-auth failures aren't, because we
 * can't tell whether the server already processed our request.
 */
const RPC_MAX_ATTEMPTS = 3;
const RPC_RETRY_BACKOFF_MS = [300, 1000] as const;

type RpcResult<T = unknown> =
  | { ok: true; payload: T }
  | { ok: false; error: string; retryable?: boolean };

const extractErrorMessage = (error: unknown): string => {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const obj = error as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.code === "string") return obj.code;
    try {
      return JSON.stringify(error);
    } catch {
      return "Unknown gateway error";
    }
  }
  return "Unknown gateway error";
};

interface GatewayConfigPayload {
  config: Record<string, unknown>;
  hash?: string;
}

const generateRequestId = (): string =>
  `rpc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Build the `connect` request params.
 *
 * Uses operator role + token auth so `roleCanSkipDeviceIdentity` returns true
 * on the gateway side — no Ed25519 device identity needed.
 */
const buildConnectParams = (
  gatewayToken: string,
): Record<string, unknown> => ({
  minProtocol: 3,
  maxProtocol: 3,
  client: {
    id: GATEWAY_CLIENT_ID,
    version: "dev",
    platform: process.platform,
    mode: "backend",
    instanceId: "pinai-rpc-client",
  },
  role: GATEWAY_CLIENT_ROLE,
  scopes: GATEWAY_CLIENT_SCOPES,
  caps: ["tool-events"],
  commands: [],
  permissions: {},
  auth: { token: gatewayToken },
  userAgent: "pinai-model-manager",
  locale: "en-US",
});

/**
 * Single attempt: open a WebSocket to the gateway, authenticate via `connect`,
 * send one RPC request, return the response.
 *
 * Each failure path marks `retryable` based on whether our request was
 * actually sent. Pre-`authenticated` failures (handshake-stage) are safe to
 * retry; post-`authenticated` failures aren't, since the gateway may have
 * processed `config.patch` before the connection died.
 */
const rpcCallOnce = <T = unknown>(
  target: GatewayTarget,
  gatewayToken: string,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = READ_RPC_TIMEOUT_MS,
): Promise<RpcResult<T>> =>
  new Promise((resolve) => {
    const ws = new WebSocket(target.wsBaseUrl, {
      maxPayload: 4 * 1024 * 1024,
      headers: gatewayHostHeaders(target),
    });
    let settled = false;

    const connectId = generateRequestId();
    const requestId = generateRequestId();

    const finish = (result: RpcResult<T>): void => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // ignore
      }
      resolve(result);
    };

    let authenticated = false;

    const timeout = setTimeout(() => {
      finish({
        ok: false,
        error: "Gateway RPC timed out",
        retryable: !authenticated,
      });
    }, timeoutMs);
    timeout.unref();

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          type: "req",
          id: connectId,
          method: "connect",
          params: buildConnectParams(gatewayToken),
        }),
      );
    });

    ws.on("message", (raw) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!data || typeof data !== "object") return;

      if (data.type === "res" && data.id === connectId) {
        if (!data.ok) {
          clearTimeout(timeout);
          // Connect-ack rejected = auth/protocol mismatch. The server is up
          // and answering; retry won't fix a bad token. Don't retry.
          finish({
            ok: false,
            error: extractErrorMessage(data.error),
            retryable: false,
          });
          return;
        }
        authenticated = true;

        // Now send the actual RPC request
        ws.send(
          JSON.stringify({
            type: "req",
            id: requestId,
            method,
            params,
          }),
        );
      }

      if (data.type === "res" && data.id === requestId && authenticated) {
        clearTimeout(timeout);
        if (data.ok) {
          finish({ ok: true, payload: data.payload as T });
        } else {
          // Business-level rejection (e.g. baseHash mismatch). Surface it;
          // retrying the same request would just hit the same error.
          finish({
            ok: false,
            error: extractErrorMessage(data.error),
            retryable: false,
          });
        }
      }
    });

    ws.on("close", () => {
      clearTimeout(timeout);
      finish({
        ok: false,
        error: authenticated
          ? "Gateway WebSocket closed mid-request"
          : "Gateway WebSocket closed before connect ack",
        retryable: !authenticated,
      });
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      finish({
        ok: false,
        error: `Gateway WebSocket error: ${err.message}`,
        retryable: !authenticated,
      });
    });
  });

/**
 * Open a WebSocket to the gateway, authenticate via `connect`, send a single
 * RPC request, and return the response payload.
 *
 * Wraps {@link rpcCallOnce} with bounded retry on handshake-stage failures.
 * Backoff: immediate, 300ms, 1000ms (3 attempts total).
 */
const rpcCall = async <T = unknown>(
  target: GatewayTarget,
  gatewayToken: string,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = READ_RPC_TIMEOUT_MS,
): Promise<RpcResult<T>> => {
  let lastResult: RpcResult<T> = {
    ok: false,
    error: "Unknown gateway error",
  };
  for (let attempt = 0; attempt < RPC_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const delay = RPC_RETRY_BACKOFF_MS[attempt - 1] ?? 1000;
      await new Promise((r) => setTimeout(r, delay));
    }
    lastResult = await rpcCallOnce<T>(
      target,
      gatewayToken,
      method,
      params,
      timeoutMs,
    );
    if (lastResult.ok) return lastResult;
    if (!lastResult.retryable) return lastResult;
  }
  return lastResult;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch the current OpenClaw gateway config via `config.get` RPC.
 */
export const getGatewayConfig = async (
  target: GatewayTarget,
  gatewayToken: string,
): Promise<RpcResult<GatewayConfigPayload>> => {
  return rpcCall<GatewayConfigPayload>(target, gatewayToken, "config.get");
};

/**
 * Patch the gateway config via `config.patch` RPC.
 *
 * OpenClaw expects `{ raw: "<partial JSON>", baseHash: "<hash>" }`.
 * The `baseHash` comes from a prior `config.get` response and is used for
 * optimistic concurrency control.
 */
export const patchGatewayConfig = async (
  target: GatewayTarget,
  gatewayToken: string,
  partialConfig: Record<string, unknown>,
  baseHash: string,
): Promise<RpcResult> => {
  return rpcCall(
    target,
    gatewayToken,
    "config.patch",
    {
      raw: JSON.stringify(partialConfig),
      baseHash,
    },
    PATCH_RPC_TIMEOUT_MS,
  );
};

// ---------------------------------------------------------------------------
// Helpers: deep get/set on nested objects
// ---------------------------------------------------------------------------

const deepGet = (
  obj: Record<string, unknown>,
  path: string,
): unknown => {
  const keys = path.split(".");
  let current: unknown = obj;
  for (const key of keys) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
};

const deepSet = (
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> => {
  const clone = structuredClone(obj);
  const keys = path.split(".");
  const lastKey = keys.pop()!;
  let current: Record<string, unknown> = clone;
  for (const key of keys) {
    if (current[key] == null || typeof current[key] !== "object") {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[lastKey] = value;
  return clone;
};

// ---------------------------------------------------------------------------
// Model-specific helpers
// ---------------------------------------------------------------------------

const getPrimaryModelFromConfig = (
  config: Record<string, unknown>,
): string | null => {
  const primary = deepGet(config, "agents.defaults.model.primary");
  if (typeof primary === "string") return primary;

  const model = deepGet(config, "agents.defaults.model");
  if (typeof model === "string") return model;

  return null;
};

/**
 * Read the current primary model from a running gateway.
 * Returns the model ref string (e.g. `litellm/claude-opus-4-6`) or null.
 */
export const getCurrentModel = async (
  target: GatewayTarget,
  gatewayToken: string,
): Promise<string | null> => {
  const result = await getGatewayConfig(target, gatewayToken);
  if (!result.ok) return null;

  try {
    return getPrimaryModelFromConfig(result.payload.config);
  } catch {
    // ignore parse failures
  }
  return null;
};

/**
 * Set the primary model on a running gateway.
 *
 * Performs get → modify → set to preserve the rest of the config.
 */
export const setCurrentModel = async (
  target: GatewayTarget,
  gatewayToken: string,
  modelRef: string,
): Promise<RpcResult> => {
  // 1. Read current config (includes baseHash for optimistic concurrency)
  const current = await getGatewayConfig(target, gatewayToken);
  if (!current.ok) {
    return { ok: false, error: `Failed to read config: ${current.error}` };
  }

  const configuredModel = getPrimaryModelFromConfig(current.payload.config);
  if (configuredModel === modelRef) {
    return { ok: true, payload: undefined };
  }

  const baseHash = current.payload.hash;
  if (!baseHash) {
    return { ok: false, error: "config.get did not return a hash" };
  }

  // 2. Build partial config with only the model change
  const patch = deepSet(
    {} as Record<string, unknown>,
    "agents.defaults.model.primary",
    modelRef,
  );

  // 3. Patch via RPC
  return patchGatewayConfig(target, gatewayToken, patch, baseHash);
};
