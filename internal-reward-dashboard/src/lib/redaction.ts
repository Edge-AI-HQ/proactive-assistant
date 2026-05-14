export const redactedSecretText = "已隐藏敏感值";

const sensitiveValueKeys = new Set(["raw_value", "secret_value", "token_value", "value"]);
const sensitiveValueLabelKeys = new Set([
  "field",
  "field_name",
  "header",
  "header_name",
  "key",
  "name",
  "property",
]);

export function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  return /(^|[_-])(api[_-]?key|authorization|cookie|credential|password|private[_-]?key|refresh[_-]?token|secret|session|token)([_-]|$)/i.test(normalized);
}

function normalizedPayloadKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/-/g, "_").toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function redactSensitivePayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitivePayload(item));
  }
  if (isRecord(value)) {
    const hasSensitiveValueLabel = Object.entries(value).some(([key, nestedValue]) => (
      sensitiveValueLabelKeys.has(normalizedPayloadKey(key)) && typeof nestedValue === "string" && isSensitiveKey(nestedValue)
    ));
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        isSensitiveKey(key) || (hasSensitiveValueLabel && sensitiveValueKeys.has(normalizedPayloadKey(key)))
          ? redactedSecretText
          : redactSensitivePayload(nestedValue),
      ]),
    );
  }
  return value;
}

function redactJsonText(value: string): string | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    return JSON.stringify(redactSensitivePayload(parsed));
  } catch {
    return null;
  }
}

export function redactSensitiveText(value: string): string {
  const jsonText = redactJsonText(value.trim());
  const text = jsonText ?? value;
  const sensitiveKey = [
    "api[_-]?key",
    "authorization",
    "cookie",
    "credential",
    "password",
    "private[_-]?key",
    "refresh[_-]?token",
    "access[_-]?token",
    "client[_-]?secret",
    "secret",
    "session(?:[_-]?token)?",
    "token",
  ].join("|");
  const queryParamPattern = new RegExp(`([?&](?:${sensitiveKey})=)([^&#\\s]+)`, "gi");
  const keyValuePattern = new RegExp(`\\b(${sensitiveKey})\\b(\\s*[:=]\\s*)(["']?)([^"',;&\\]}\\s]+(?:\\s+[^"',;&\\]}\\s]+){0,3})\\3`, "gi");

  return text
    .replace(queryParamPattern, `$1${redactedSecretText}`)
    .replace(keyValuePattern, (_match, key: string, separator: string, quote: string) =>
      `${key}${separator}${quote}${redactedSecretText}${quote}`,
    );
}

export function redactedJsonString(value: unknown): string {
  return JSON.stringify(redactSensitivePayload(value), null, 2);
}
