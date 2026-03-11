import type { Request } from 'express';
import { resolveGatewayTargetForAssistant } from '../container/index.js';
import type { AssistantRecord } from '../../types.js';

export const buildOpenclawAuthHeaders = (gatewayToken: string): Record<string, string> => {
  const token = gatewayToken.trim();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
};

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
