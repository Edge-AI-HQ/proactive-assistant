import crypto from "node:crypto";

export const QUICKSTART_SYNTHETIC_BOT_TOKEN =
  "0:pinai_quickstart_proxy_token_20260305";

export const deriveAssistantWebhookSecret = (
  assistantBotId: number,
  gatewayToken: string,
  apiInternalToken: string | null | undefined,
): string => {
  const normalizedAssistantBotId = Number.isFinite(assistantBotId)
    ? String(assistantBotId)
    : "0";
  const normalizedGatewayToken = (gatewayToken || "").trim();
  const normalizedApiInternalToken = (apiInternalToken || "").trim();
  const secretSalt =
    normalizedApiInternalToken ||
    `pinai-fallback-${normalizedAssistantBotId}-${normalizedGatewayToken.slice(0, 8)}`;

  return crypto
    .createHmac("sha256", secretSalt)
    .update(`${normalizedAssistantBotId}:${normalizedGatewayToken}`)
    .digest("hex");
};
