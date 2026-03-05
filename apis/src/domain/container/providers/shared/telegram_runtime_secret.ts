import crypto from "node:crypto";

export const QUICKSTART_SYNTHETIC_BOT_TOKEN =
  "0:pinai_quickstart_proxy_token_20260305";

export const deriveAssistantWebhookSecret = (
  assistantBotId: number,
  gatewayToken: string,
  apiInternalToken: string | null | undefined,
): string => {
  void assistantBotId;
  const normalizedGatewayToken = (gatewayToken || "").trim();
  const normalizedApiInternalToken = (apiInternalToken || "").trim();
  const secretSalt =
    normalizedApiInternalToken ||
    `pinai-fallback-${normalizedGatewayToken.slice(0, 8)}`;

  return crypto
    .createHmac("sha256", secretSalt)
    .update(normalizedGatewayToken)
    .digest("hex");
};
