import { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { Socket } from "node:net";
import type { GatewayTarget } from "../container/contracts.js";
import { gatewayHostHeaders } from "../container/contracts.js";
import {
  GATEWAY_CLIENT_ID,
  GATEWAY_CLIENT_ROLE,
  GATEWAY_CLIENT_SCOPES,
} from "./gateway_constants.js";

// ---------------------------------------------------------------------------
// Gateway WebSocket Relay
//
// The browser's Control UI JS sends `connect` without proper auth credentials.
// We relay the connection and inject operator-level auth into the `connect`
// message so the gateway accepts it via the operator+token fast path
// (roleCanSkipDeviceIdentity) — no device identity or Ed25519 crypto needed.
//
//   Browser <--WS--> APIs relay <--WS--> OpenClaw gateway
// ---------------------------------------------------------------------------

/** Close codes valid to send in a close frame per RFC 6455 §7.4.1 */
function isForwardableCloseCode(code: number): boolean {
  return (
    (code >= 1000 && code <= 1003) ||
    (code >= 1007 && code <= 1014) ||
    (code >= 3000 && code <= 4999)
  );
}

const wss = new WebSocketServer({ noServer: true });

/**
 * Handle a browser WS upgrade by relaying to the OpenClaw gateway with
 * operator auth injection.
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
        Authorization: `Bearer ${gatewayToken}`,
      },
    });

    let upstreamReady = false;
    const pendingBrowserMessages: { data: Buffer | string; isBinary: boolean }[] = [];
    let connectInjected = false;

    // ── Upstream (gateway) events ──

    upstreamWs.on("open", () => {
      upstreamReady = true;
      for (const msg of pendingBrowserMessages) {
        forwardToUpstream(msg.data, msg.isBinary);
      }
      pendingBrowserMessages.length = 0;
    });

    upstreamWs.on("message", (data, isBinary) => {
      if (browserWs.readyState === WebSocket.OPEN) {
        browserWs.send(data, { binary: isBinary });
      }
    });

    upstreamWs.on("close", (code, reason) => {
      if (browserWs.readyState === WebSocket.OPEN) {
        if (isForwardableCloseCode(code)) {
          browserWs.close(code, reason);
        } else {
          browserWs.close();
        }
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
        if (isForwardableCloseCode(code)) {
          upstreamWs.close(code, reason);
        } else {
          upstreamWs.close();
        }
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

      // Intercept the first `connect` message to inject operator auth
      if (!connectInjected && !isBinary) {
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

            // Set our backend client identity as Control UI for scope preservation
            if (typeof params.client === "object" && params.client !== null) {
              (params.client as Record<string, unknown>).id = GATEWAY_CLIENT_ID;
              (params.client as Record<string, unknown>).mode = "ui";
            }
            params.role = GATEWAY_CLIENT_ROLE;
            params.scopes = GATEWAY_CLIENT_SCOPES;

            // Strip browser device block — its signature is bound to the
            // original client ID and would be invalid after our rewrite.
            // Operator+token auth bypasses device identity entirely.
            delete params.device;

            // Inject token auth
            if (!params.auth || typeof params.auth !== "object") {
              params.auth = { token: gatewayToken };
            } else {
              (params.auth as Record<string, unknown>).token = gatewayToken;
            }

            connectInjected = true;
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
