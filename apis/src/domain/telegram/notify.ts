import { config } from "../common/config.js";

const TELEGRAM_API_BASE = "https://api.telegram.org";

/**
 * Send a plain text message to a user via the guide bot (TELEGRAM_BOT_TOKEN).
 * Used e.g. after payment to notify "container is ready".
 * No-op if token is not configured.
 */
export async function sendTelegramMessage(
  chatId: number,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  const token = (config.telegram.token ?? "").trim();
  if (!token) {
    console.warn("sendTelegramMessage skipped: TELEGRAM_BOT_TOKEN not set ");
    return { ok: false, error: "TELEGRAM_BOT_TOKEN not set" };
  }

  const url = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      description?: string;
    };
    if (!res.ok || !data.ok) {
      console.warn("sendTelegramMessage failed", {
        chatId,
        status: res.status,
        description: data.description,
      });
      return { ok: false, error: data.description ?? `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("sendTelegramMessage error", { chatId, error: message });
    return { ok: false, error: message };
  }
}
