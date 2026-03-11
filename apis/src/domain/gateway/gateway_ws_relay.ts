import { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { Socket } from "node:net";
import type { GatewayTarget } from "../container/contracts.js";
import { gatewayHostHeaders } from "../container/contracts.js";
import {
  buildDeviceBlock,
  GATEWAY_CLIENT_ID,
  GATEWAY_CLIENT_ROLE,
  GATEWAY_CLIENT_SCOPES,
} from "./device_identity.js";

// ---------------------------------------------------------------------------
// Gateway WebSocket Relay
//
// Instead of raw-proxying the browser WS to the OpenClaw gateway (which fails
// because the browser's Control UI JS sends `connect` without a device block),
// we act as a relay:
//
//   Browser <--WS--> APIs relay <--WS--> OpenClaw gateway
//
// The relay intercepts the `connect` message from the browser, injects an
// Ed25519 device identity block (signed against the gateway's challenge), and
// forwards it.  All other messages pass through unmodified.
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true });

/**
 * Handle a browser WS upgrade by relaying to the OpenClaw gateway with
 * device identity injection.
 */
export const relayGatewayWs = (
  req: IncomingMessage,
  socket: Socket,
  head: Buffer,
  target: GatewayTarget,
  gatewayToken: string,
): void => {
  wss.handleUpgrade(req, socket, head, (browserWs) => {
    const upstreamWs = new WebSocket(target.wsBaseUrl, {
      maxPayload: 4 * 1024 * 1024,
      headers: {
        ...gatewayHostHeaders(target),
        "X-Forwarded-For": "127.0.0.1",
        Origin: target.httpBaseUrl,
        Authorization: `Bearer ${gatewayToken}`,
      },
    });

    let upstreamReady = false;
    let challengeNonce: string | null = null;
    let challengeTs: number | null = null;
    // Buffer browser messages until upstream is open
    const pendingBrowserMessages: { data: Buffer | string; isBinary: boolean }[] = [];
    // Track if we've already injected device identity into a connect message
    let deviceInjected = false;

    // ── Upstream (gateway) events ──

    upstreamWs.on("open", () => {
      upstreamReady = true;
      // Flush buffered browser messages
      for (const msg of pendingBrowserMessages) {
        forwardToUpstream(msg.data, msg.isBinary);
      }
      pendingBrowserMessages.length = 0;
    });

    upstreamWs.on("message", (data, isBinary) => {
      // Check for connect.challenge from gateway
      if (!deviceInjected && !isBinary) {
        try {
          const parsed = JSON.parse(String(data)) as Record<string, unknown>;
          if (
            parsed.type === "event" &&
            parsed.event === "connect.challenge"
          ) {
            const payload = parsed.data as
              | { nonce?: string; ts?: number }
              | undefined;
            if (payload?.nonce) {
              challengeNonce = payload.nonce;
              challengeTs =
                typeof payload.ts === "number" ? payload.ts : Date.now();
            }
          }
        } catch {
          // not JSON, pass through
        }
      }

      // Forward everything to browser
      if (browserWs.readyState === WebSocket.OPEN) {
        browserWs.send(data, { binary: isBinary });
      }
    });

    upstreamWs.on("close", (code, reason) => {
      if (browserWs.readyState === WebSocket.OPEN) {
        browserWs.close(code, reason);
      }
    });

    upstreamWs.on("error", (err) => {
      console.error("[gateway-ws-relay] upstream error:", err.message);
      if (browserWs.readyState === WebSocket.OPEN) {
        browserWs.close(1011, "upstream error");
      }
    });

    // ── Browser events ──

    browserWs.on("message", (data, isBinary) => {
      if (!upstreamReady) {
        pendingBrowserMessages.push({
          data: isBinary ? (data as Buffer) : String(data),
          isBinary,
        });
        return;
      }
      forwardToUpstream(isBinary ? Buffer.from(data as ArrayBuffer) : String(data), isBinary);
    });

    browserWs.on("close", (code, reason) => {
      if (upstreamWs.readyState === WebSocket.OPEN) {
        upstreamWs.close(code, reason);
      }
    });

    browserWs.on("error", (err) => {
      console.error("[gateway-ws-relay] browser error:", err.message);
      if (upstreamWs.readyState === WebSocket.OPEN) {
        upstreamWs.close(1011, "browser error");
      }
    });

    // ── Helpers ──

    function forwardToUpstream(
      data: Buffer | string | Buffer[],
      isBinary: boolean,
    ): void {
      if (upstreamWs.readyState !== WebSocket.OPEN) return;

      // Try to intercept `connect` messages to inject device identity
      if (!deviceInjected && !isBinary) {
        const text = String(data);
        try {
          const parsed = JSON.parse(text) as Record<string, unknown>;
          if (
            parsed.type === "req" &&
            parsed.method === "connect" &&
            typeof parsed.params === "object" &&
            parsed.params !== null
          ) {
            const params = parsed.params as Record<string, unknown>;

            // Ensure client.id is set to our Control UI identity
            if (typeof params.client === "object" && params.client !== null) {
              (params.client as Record<string, unknown>).id =
                GATEWAY_CLIENT_ID;
            }
            params.role = GATEWAY_CLIENT_ROLE;
            params.scopes = GATEWAY_CLIENT_SCOPES;

            // Ensure token auth is present
            if (!params.auth || typeof params.auth !== "object") {
              params.auth = { token: gatewayToken };
            } else {
              (params.auth as Record<string, unknown>).token = gatewayToken;
            }

            // Inject device identity if we have a challenge
            if (challengeNonce) {
              params.device = buildDeviceBlock(
                {
                  clientId: GATEWAY_CLIENT_ID,
                  clientMode: String(
                    (params.client as Record<string, unknown>)?.mode ||
                      "browser",
                  ),
                  role: GATEWAY_CLIENT_ROLE,
                  scopes: GATEWAY_CLIENT_SCOPES,
                  token: gatewayToken,
                },
                {
                  nonce: challengeNonce,
                  ts: challengeTs ?? Date.now(),
                },
              );
            }

            deviceInjected = true;
            upstreamWs.send(JSON.stringify(parsed));
            return;
          }
        } catch {
          // Not valid JSON or not a connect message — pass through
        }
      }

      upstreamWs.send(data, { binary: isBinary });
    }
  });
};
