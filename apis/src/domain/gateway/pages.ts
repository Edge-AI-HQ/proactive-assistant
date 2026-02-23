import type { Request } from 'express';
import { config } from '../common/config.js';

const toSingleString = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
};

export const resolveGatewayWsUrl = (req: Request, telegramUserId: number, assistantId: number): string => {
  const forwardedProto = toSingleString(req.headers['x-forwarded-proto'])?.split(',')[0]?.trim().toLowerCase();
  const protocol = forwardedProto === 'https' || req.secure ? 'wss' : 'ws';

  const forwardedHost = toSingleString(req.headers['x-forwarded-host'])?.split(',')[0]?.trim();
  const host = forwardedHost || req.get('host');
  if (host) {
    return `${protocol}://${host}/gateway/${telegramUserId}/bot/${assistantId}/ws`;
  }

  const base = new URL(config.publicBaseUrl);
  const fallbackProtocol = base.protocol === 'https:' ? 'wss' : 'ws';
  return `${fallbackProtocol}://${base.host}/gateway/${telegramUserId}/bot/${assistantId}/ws`;
};

export const renderGatewayBootstrapPageHtml = (params: {
  userId: number;
  assistantId: number;
  gatewayUrl: string;
  gatewayToken: string;
}): string => {
  const { userId, assistantId, gatewayUrl, gatewayToken } = params;
  const nextPath = `/gateway/${userId}/bot/${assistantId}/proxy/overview`;
  const script = `
(() => {
  const key = 'openclaw.control.settings.v1';
  const next = ${JSON.stringify(nextPath)};
  const gatewayUrl = ${JSON.stringify(gatewayUrl)};
  const token = ${JSON.stringify(gatewayToken)};
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : {};
    const merged = parsed && typeof parsed === 'object' ? parsed : {};
    merged.gatewayUrl = gatewayUrl;
    merged.token = token;
    localStorage.setItem(key, JSON.stringify(merged));
  } catch (error) {
    console.error('Gateway bootstrap failed', error);
  }
  window.location.replace(next);
})();
  `.trim();

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Gateway Bootstrap</title>
  </head>
  <body>
    <p>Preparing assistant dashboard...</p>
    <script>${script}</script>
  </body>
</html>`;
};
