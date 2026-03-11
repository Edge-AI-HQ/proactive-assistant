import net from "node:net";
import WebSocket from "ws";
import type { ProbeOptions } from "../../contracts.js";

// ---------------------------------------------------------------------------
// Shared gateway probe utilities
//
// Used by both Fly and Docker providers to verify that the OpenClaw gateway
// is reachable, authenticated, and serving HTTP probes.
// ---------------------------------------------------------------------------

/** Client identity for probe connections — matches gateway_constants.ts values. */
const PROBE_CLIENT_ID = "pin-ai-backend";
const PROBE_CLIENT_ROLE = "operator";
const PROBE_CLIENT_SCOPES = ["operator.admin"];

const DEFAULT_PORT_TIMEOUT_MS = 120_000;
const CONNECT_PROBE_REQUEST_ID = "gateway-probe-connect";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

export const formatHostForUrl = (host: string): string => {
  if (host.includes(":") && !host.startsWith("[")) {
    return `[${host}]`;
  }
  return host;
};

/**
 * Wait for a TCP port to accept connections.
 */
export const waitForPort = (
  host: string,
  port: number,
  timeoutMs = DEFAULT_PORT_TIMEOUT_MS,
): Promise<boolean> =>
  new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;

    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    const scheduleRetry = (): void => {
      if (Date.now() - startedAt >= timeoutMs) {
        finish(false);
        return;
      }
      setTimeout(tryConnect, 1000);
    };

    const tryConnect = (): void => {
      if (settled) return;
      const socket = net.createConnection({ host, port }, () => {
        socket.end();
        finish(true);
      });

      socket.setTimeout(3000);

      socket.on("timeout", () => {
        socket.destroy();
        scheduleRetry();
      });

      socket.on("error", () => {
        socket.destroy();
        scheduleRetry();
      });
    };

    tryConnect();
  });

/**
 * Single-shot WebSocket `connect` handshake probe.
 *
 * Uses operator + token auth so the gateway's `roleCanSkipDeviceIdentity`
 * allows the connection without device identity.
 */
const probeGatewayHelloOnce = (
  host: string,
  port: number,
  gatewayToken: string,
  hostOverride?: string,
): Promise<boolean> =>
  new Promise((resolve) => {
    const wsUrl = `ws://${formatHostForUrl(host)}:${port}`;
    const ws = new WebSocket(wsUrl, {
      maxPayload: 2 * 1024 * 1024,
      headers: {
        ...(hostOverride ? { Host: hostOverride } : {}),
      },
    });
    let settled = false;
    let sent = false;

    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // ignore close failures during probe
      }
      resolve(ok);
    };

    const sendConnect = (): void => {
      if (sent) return;
      sent = true;
      const token = gatewayToken.trim();
      const params: Record<string, unknown> = {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: PROBE_CLIENT_ID,
          version: "dev",
          platform: process.platform,
          mode: "backend",
          instanceId: "pinai-gateway-probe",
        },
        role: PROBE_CLIENT_ROLE,
        scopes: PROBE_CLIENT_SCOPES,
        caps: ["tool-events"],
        commands: [],
        permissions: {},
        userAgent: "pinai-gateway-probe",
        locale: "en-US",
      };
      if (token) {
        params.auth = { token };
      }

      ws.send(
        JSON.stringify({
          type: "req",
          id: CONNECT_PROBE_REQUEST_ID,
          method: "connect",
          params,
        }),
      );
    };

    const timeout = setTimeout(() => finish(false), 5000);
    timeout.unref();

    ws.on("open", () => sendConnect());

    ws.on("message", (raw) => {
      let payload: unknown;
      try {
        payload = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!payload || typeof payload !== "object") return;
      const data = payload as Record<string, unknown>;
      if (data.type === "res" && data.id === CONNECT_PROBE_REQUEST_ID) {
        clearTimeout(timeout);
        finish(Boolean(data.ok));
      }
    });

    ws.on("close", () => {
      clearTimeout(timeout);
      finish(false);
    });

    ws.on("error", () => {
      clearTimeout(timeout);
      finish(false);
    });
  });

/**
 * Retry gateway WebSocket `connect` until success or timeout.
 */
export const waitForGatewayHello = async (
  host: string,
  port: number,
  gatewayToken: string,
  timeoutMs: number,
  hostOverride?: string,
): Promise<boolean> => {
  const startedAt = Date.now();
  const token = gatewayToken.trim();
  while (Date.now() - startedAt < timeoutMs) {
    const ok = await probeGatewayHelloOnce(host, port, token, hostOverride);
    if (ok) return true;
    await sleep(1000);
  }
  return false;
};

/**
 * Wait for an HTTP endpoint to return any response.
 */
export const waitForHttpReady = async (
  host: string,
  port: number,
  urlPath: string,
  timeoutMs: number,
  hostOverride?: string,
): Promise<boolean> => {
  const startedAt = Date.now();
  const normalizedPath = urlPath.startsWith("/") ? urlPath : `/${urlPath}`;
  const url = `http://${formatHostForUrl(host)}:${port}${normalizedPath}`;

  while (Date.now() - startedAt < timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    timer.unref();
    try {
      const response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        ...(hostOverride ? { headers: { Host: hostOverride } } : {}),
      });
      clearTimeout(timer);
      if (response.status >= 100 && response.status < 600) {
        return true;
      }
    } catch {
      clearTimeout(timer);
      // retry until timeout
    }
    await sleep(1000);
  }
  return false;
};

// ---------------------------------------------------------------------------
// High-level: unified probe sequence
// ---------------------------------------------------------------------------

export interface ResolvedProbeTarget {
  /** Host to connect to (e.g. "127.0.0.1" or Fly IPv6 address). */
  host: string;
  /** Host-mapped gateway port. */
  gatewayPort: number;
  /** Override Host header for WS/HTTP probes (e.g. Fly loopback workaround). */
  hostOverride?: string;
  /** Host-mapped additional ports to TCP-check (e.g. webhook). */
  additionalPorts?: number[];
  /** Host-mapped HTTP probes. */
  httpProbes?: Array<{ port: number; path: string }>;
}

/**
 * Unified probe sequence used by all providers:
 *
 * 1. TCP check on gateway port
 * 2. WebSocket `connect` handshake (if gatewayToken provided)
 * 3. TCP check on additional ports
 * 4. HTTP probes (non-fatal — logged as warnings)
 *
 * The gateway hello (step 2) is the authoritative readiness signal.
 * HTTP probes (step 4) are best-effort: failure is logged but does NOT
 * block the container from being marked as running.
 */
export const probeGatewayReady = async (
  target: ResolvedProbeTarget,
  options: ProbeOptions,
): Promise<boolean> => {
  const { host, gatewayPort, hostOverride } = target;
  const { timeoutMs, gatewayToken } = options;

  // 1. TCP: gateway port
  const portReady = await waitForPort(host, gatewayPort, timeoutMs);
  if (!portReady) return false;

  // 2. WebSocket connect handshake (authoritative readiness)
  if (gatewayToken) {
    const gatewayOk = await waitForGatewayHello(
      host,
      gatewayPort,
      gatewayToken,
      timeoutMs,
      hostOverride,
    );
    if (!gatewayOk) return false;
  }

  // Gateway hello succeeded — fire the early-ready callback so the caller
  // can update DB status immediately without waiting for supplementary probes.
  options.onGatewayReady?.();

  // 3. TCP: additional ports (webhook, etc.) — best-effort, don't block
  if (target.additionalPorts?.length) {
    for (const port of target.additionalPorts) {
      const ok = await waitForPort(host, port, Math.min(timeoutMs, 30_000));
      if (!ok) {
        console.warn(
          `[gateway-probe] Additional port check failed (non-fatal): ${host}:${port}`,
        );
      }
    }
  }

  // 4. HTTP probes — best-effort (warn on failure, don't block)
  if (target.httpProbes?.length) {
    for (const probe of target.httpProbes) {
      const ok = await waitForHttpReady(
        host,
        probe.port,
        probe.path,
        Math.min(timeoutMs, 30_000),
        hostOverride,
      );
      if (!ok) {
        console.warn(
          `[gateway-probe] HTTP probe failed (non-fatal): ${host}:${probe.port}${probe.path}`,
        );
      }
    }
  }

  return true;
};
