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
// handshake as operator with token auth (no device identity needed), then
// issues a single RPC request and returns the result.
// ---------------------------------------------------------------------------

const RPC_TIMEOUT_MS = 10_000;

type RpcResult<T = unknown> =
  | { ok: true; payload: T }
  | { ok: false; error: string };

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
 * Open a WebSocket to the gateway, authenticate via `connect`, send a single
 * RPC request, and return the response payload.
 */
const rpcCall = <T = unknown>(
  target: GatewayTarget,
  gatewayToken: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<RpcResult<T>> =>
  new Promise((resolve) => {
    const ws = new WebSocket(target.wsBaseUrl, {
      maxPayload: 4 * 1024 * 1024,
      headers: {
        ...gatewayHostHeaders(target),
        Origin: target.httpBaseUrl,
      },
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

    const timeout = setTimeout(() => {
      finish({ ok: false, error: "Gateway RPC timed out" });
    }, RPC_TIMEOUT_MS);
    timeout.unref();

    let authenticated = false;

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
          finish({
            ok: false,
            error: extractErrorMessage(data.error),
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
          finish({
            ok: false,
            error: extractErrorMessage(data.error),
          });
        }
      }
    });

    ws.on("close", () => {
      clearTimeout(timeout);
      finish({ ok: false, error: "Gateway WebSocket closed unexpectedly" });
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      finish({
        ok: false,
        error: `Gateway WebSocket error: ${err.message}`,
      });
    });
  });

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
  return rpcCall(target, gatewayToken, "config.patch", {
    raw: JSON.stringify(partialConfig),
    baseHash,
  });
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
    const primary = deepGet(
      result.payload.config,
      "agents.defaults.model.primary",
    );
    if (typeof primary === "string") return primary;

    const model = deepGet(result.payload.config, "agents.defaults.model");
    if (typeof model === "string") return model;
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
