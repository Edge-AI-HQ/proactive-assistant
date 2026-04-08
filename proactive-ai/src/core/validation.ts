/**
 * Input validation utilities shared across all domains.
 *
 * Moved from pin-cli/src/output/sanitize.ts + inline helpers in services.
 * All validation functions throw ValidationError on failure.
 */

import { ValidationError } from "./errors.js";

// ── Unicode safety ──

const isDangerousUnicode = (code: number): boolean =>
  // Zero-width: ZWSP, ZWNJ, ZWJ
  (code >= 0x200b && code <= 0x200d) ||
  // BOM / ZWNBSP
  code === 0xfeff ||
  // BiDi overrides: LRE, RLE, PDF, LRO, RLO
  (code >= 0x202a && code <= 0x202e) ||
  // Line/paragraph separators
  code === 0x2028 ||
  code === 0x2029 ||
  // BiDi isolates: LRI, RLI, FSI, PDI
  (code >= 0x2066 && code <= 0x2069);

export const rejectDangerousChars = (
  paramName: string,
  value: string,
): void => {
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code !== undefined && isDangerousUnicode(code)) {
      throw new ValidationError(
        "INVALID_ARGUMENT",
        `Parameter '${paramName}': contains dangerous Unicode character U+${code.toString(16).toUpperCase().padStart(4, "0")}`,
      );
    }
  }
};

export const validateSafePath = (paramName: string, path: string): void => {
  if (path.includes("..")) {
    throw new ValidationError(
      "INVALID_ARGUMENT",
      `Parameter '${paramName}': path traversal detected (..)`,
    );
  }
  if (/^[/\\]/.test(path) || /^[a-zA-Z]:/.test(path)) {
    throw new ValidationError(
      "INVALID_ARGUMENT",
      `Parameter '${paramName}': absolute paths not allowed`,
    );
  }
};

// ── Enum validation ──

export const validateEnum = (
  paramName: string,
  value: string | undefined,
  allowed: readonly string[],
): void => {
  if (value !== undefined && !allowed.includes(value)) {
    throw new ValidationError(
      "INVALID_ARGUMENT",
      `Invalid --${paramName}: ${value}. Allowed: ${allowed.join(", ")}`,
    );
  }
};

// ── Duration parsing ──

export const parseSinceToISO = (since: string | undefined): string | undefined => {
  if (!since) return undefined;
  const match = since.match(/^(\d+)(h|d|w)$/);
  if (!match) {
    throw new ValidationError(
      "INVALID_ARGUMENT",
      `Invalid --since format: ${since}. Use e.g. 7d, 24h, 2w`,
    );
  }

  const amount = parseInt(match[1], 10);
  const unit = match[2];
  const now = Date.now();
  let ms = 0;

  if (unit === "h") ms = amount * 60 * 60 * 1000;
  else if (unit === "d") ms = amount * 24 * 60 * 60 * 1000;
  else if (unit === "w") ms = amount * 7 * 24 * 60 * 60 * 1000;

  return new Date(now - ms).toISOString();
};

export const parseSinceCutoff = (since: string | undefined): string | undefined => {
  if (!since) return undefined;
  const match = since.match(/^(\d+)(h|d|w|m)$/);
  if (!match) {
    throw new ValidationError(
      "INVALID_ARGUMENT",
      `Invalid --since format: ${since}. Use e.g. 7d, 24h, 2w, 3m`,
    );
  }

  const amount = parseInt(match[1], 10);
  const unit = match[2];
  const now = Date.now();
  let ms = 0;

  if (unit === "h") ms = amount * 60 * 60 * 1000;
  else if (unit === "d") ms = amount * 24 * 60 * 60 * 1000;
  else if (unit === "w") ms = amount * 7 * 24 * 60 * 60 * 1000;
  else if (unit === "m") ms = amount * 30 * 24 * 60 * 60 * 1000;

  return new Date(now - ms).toISOString();
};

// ── JSON parsing ──

export const parseJsonValue = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    throw new ValidationError(
      "INVALID_ARGUMENT",
      `Invalid JSON: ${raw.slice(0, 100)}`,
    );
  }
};

export const parseJsonObject = (raw: string): Record<string, unknown> => {
  const parsed = parseJsonValue(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ValidationError(
      "INVALID_ARGUMENT",
      "Expected a JSON object",
    );
  }
  return parsed as Record<string, unknown>;
};

export const parseOptionalInt = (
  value: string | undefined,
  fallback: number,
): number => {
  if (value === undefined) return fallback;
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return n;
};

// ── Terminal output sanitization ──

export const sanitizeForTerminal = (text: string): string => {
  const ansiEscape = /\x1b\[[0-9;?>=!]*[a-zA-Z]|\x1b\][^\x07]*\x07/g;
  const result = text.replace(ansiEscape, "");

  let output = "";
  for (const ch of result) {
    const code = ch.codePointAt(0);
    if (code === undefined) continue;
    if (code === 0x0a || code === 0x09) {
      output += ch;
      continue;
    }
    if (code < 0x20 || code === 0x7f) continue;
    if (isDangerousUnicode(code)) continue;
    output += ch;
  }

  return output;
};
