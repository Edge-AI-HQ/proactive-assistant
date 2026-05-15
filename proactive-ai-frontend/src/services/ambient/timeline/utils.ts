import type {
  AmbientPrivacy,
  AmbientRawRef,
  AmbientSourceType,
} from "./types";

export const LOCAL_USER_ID = "local";

export function currentTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function localDateFromIso(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return localDateFromDate(new Date());
  }
  return localDateFromDate(date);
}

export function localDateFromDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function startOfLocalDay(date = new Date()): string {
  return localDateFromDate(date);
}

export function maxPrivacy(values: AmbientPrivacy[]): AmbientPrivacy {
  if (values.includes("sensitive")) return "sensitive";
  if (values.includes("private")) return "private";
  return "normal";
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function stableHash(value: string): string {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export function stableId(prefix: string, parts: unknown[]): string {
  return `${prefix}_${stableHash(JSON.stringify(parts))}`;
}

export function sourceLabel(sourceType: AmbientSourceType): string {
  switch (sourceType) {
    case "health":
      return "HealthKit";
    case "location":
      return "Location";
    case "visit":
      return "iPhone";
    case "motion":
      return "Motion";
    case "sound":
      return "Sound";
    case "transcript":
      return "Microphone";
    case "calendar":
      return "Calendar";
  }
}

export function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}

export function uniqueRawRefs(refs: AmbientRawRef[]): AmbientRawRef[] {
  const seen = new Set<string>();
  const out: AmbientRawRef[] = [];
  for (const ref of refs) {
    const key = `${ref.sourceType}:${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

export function parseOptionalNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

export function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function jsonCloneRecord(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}
