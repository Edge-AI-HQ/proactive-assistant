import { config } from "../common/config.js";

const TELEGRAM_API_BASE = "https://api.telegram.org";

const normalizeWebhookUrl = (value: string): string => value.trim().replace(/\/+$/, "");

const resolvePublicWebhookUrl = (): string => {
  const fromRouter = config.telegramRouter.webhookUrl.trim();
  if (fromRouter) return normalizeWebhookUrl(fromRouter);
  return `${config.publicBaseUrl.replace(/\/+$/, "")}/webhook/telegram`;
};

const resolvePrivateWebhookUrl = (): string => {
  const publicWebhookUrl = resolvePublicWebhookUrl();
  return publicWebhookUrl.endsWith("/private")
    ? publicWebhookUrl
    : `${publicWebhookUrl}/private`;
};

export async function setPrivateBotWebhook(
  botToken: string,
): Promise<{ ok: boolean; description?: string }> {
  const normalizedToken = botToken.trim();
  if (!normalizedToken) {
    return { ok: false, description: "empty bot token" };
  }

  const url = `${TELEGRAM_API_BASE}/bot${normalizedToken}/setWebhook`;
  const webhookUrl = resolvePrivateWebhookUrl();
  const secret = config.telegram.webhookSecret.trim();
  const payload: Record<string, unknown> = {
    url: webhookUrl,
    drop_pending_updates: false,
  };
  if (secret) {
    payload.secret_token = secret;
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      description?: string;
    };
    if (!response.ok || !data.ok) {
      return {
        ok: false,
        description: data.description || `HTTP ${response.status}`,
      };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      description: error instanceof Error ? error.message : String(error),
    };
  }
}

