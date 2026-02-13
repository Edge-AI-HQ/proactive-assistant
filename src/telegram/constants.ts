export const LOGIN_REQUIRED_MESSAGE = 'Please login first. Send /start to get the Google login link.';
export const MEDIA_GROUP_TIMEOUT_MS = 500;
export const MAX_TEXT_CHUNK = 3900;
export const TELEGRAM_STREAM_THROTTLE_MS = 800;
export const OPENCLAW_CHAT_TIMEOUT_MS = 120_000;
export const OPENCLAW_RETRY_LIMIT = 1;

export const TELEGRAM_PARSE_ERROR_RE = /can't parse entities|parse entities|find end of the entity/i;
export const OPENCLAW_TIMEOUT_ERROR_RE =
  /chat timeout|request timeout|connect timeout|gateway connect timeout/i;
export const OPENCLAW_TRANSIENT_ERROR_RE =
  /gateway (not connected|closed|disconnected)|send failed|socket hang up|econnreset|econnrefused|ehostunreach|etimedout|econnaborted/i;
export const TELEGRAM_DELIVERY_ERROR_RE =
  /ETELEGRAM|message is not modified|can't parse entities|Too Many Requests|Forbidden: bot was blocked|chat not found/i;
export const MEDIA_DIRECTIVE_RE = /[ \t]*MEDIA:\s*[^\n\r]*/gi;
