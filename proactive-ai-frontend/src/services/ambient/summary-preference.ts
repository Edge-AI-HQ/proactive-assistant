export type AmbientSummaryPreference = "cloud_when_unlocked" | "local_only";
export type AmbientSummaryEffectiveMode = "cloud_llm" | "local_llm";

export const AMBIENT_SUMMARY_PREFERENCE_STORAGE_KEY = "pin.ambient.summaryPreference";
export const DEFAULT_AMBIENT_SUMMARY_PREFERENCE: AmbientSummaryPreference = "cloud_when_unlocked";

export function loadAmbientSummaryPreference(): AmbientSummaryPreference {
  if (typeof window === "undefined") return DEFAULT_AMBIENT_SUMMARY_PREFERENCE;
  try {
    return normalizeAmbientSummaryPreference(
      window.localStorage.getItem(AMBIENT_SUMMARY_PREFERENCE_STORAGE_KEY),
    );
  } catch {
    return DEFAULT_AMBIENT_SUMMARY_PREFERENCE;
  }
}

const listeners = new Set<(value: AmbientSummaryPreference) => void>();

export function saveAmbientSummaryPreference(value: AmbientSummaryPreference): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(AMBIENT_SUMMARY_PREFERENCE_STORAGE_KEY, value);
  } catch {
    // local device preference only; ignore storage failures
  }
  for (const listener of listeners) listener(value);
}

export function normalizeAmbientSummaryPreference(
  value: string | null | undefined,
): AmbientSummaryPreference {
  return value === "local_only" || value === "cloud_when_unlocked"
    ? value
    : DEFAULT_AMBIENT_SUMMARY_PREFERENCE;
}

export function effectiveAmbientSummaryMode(input: {
  uploadsLocked: boolean;
  preference?: AmbientSummaryPreference;
}): AmbientSummaryEffectiveMode {
  if (input.uploadsLocked) return "local_llm";
  const preference = input.preference ?? loadAmbientSummaryPreference();
  return preference === "local_only" ? "local_llm" : "cloud_llm";
}

export function subscribeAmbientSummaryPreference(
  listener: (value: AmbientSummaryPreference) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
