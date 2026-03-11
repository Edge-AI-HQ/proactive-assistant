import type { Request } from 'express';
import { resolveGatewayTargetForAssistant } from '../container/index.js';
import type { AssistantRecord } from '../../types.js';
import type { GatewayTarget } from '../container/contracts.js';

export const buildOpenclawAuthHeaders = (gatewayToken: string): Record<string, string> => {
  const token = gatewayToken.trim();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
};

/**
 * Headers that make the OpenClaw gateway classify a **browser-proxied**
 * connection as local.
 *
 * Only sets `X-Forwarded-For: 127.0.0.1` — the browser's own Origin and
 * Host headers are preserved so the gateway's origin validation succeeds
 * (via `dangerouslyAllowHostHeaderOriginFallback`).
 *
 * Do NOT inject `Origin` here — it would replace the browser's real Origin
 * (e.g. an ngrok or Fly public URL) with a 127.0.0.1 URL that doesn't
 * match the Host header the browser sends.
 */
export const buildGatewayLocalHeaders = (_target: GatewayTarget): Record<string, string> => ({
  "X-Forwarded-For": "127.0.0.1",
});

export const rewriteGatewayProxyRequestUrl = (req: Request, params: { telegramUserId: number; assistantId: number }): void => {
  const { telegramUserId, assistantId } = params;
  const prefix = `/gateway/${telegramUserId}/bot/${assistantId}/proxy`;
  const url = new URL(req.originalUrl, 'http://localhost');
  const pathAfterPrefix = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname;
  url.pathname = pathAfterPrefix || '/';
  url.searchParams.delete('token');
  req.url = `${url.pathname}${url.search}`;
};

export const resolveAssistantGatewayTarget = (assistant: AssistantRecord) => {
  return resolveGatewayTargetForAssistant({
    assistant_bot_id: assistant.assistant_bot_id,
    container_id: assistant.container_id,
    container_port: assistant.container_port
  });
};
