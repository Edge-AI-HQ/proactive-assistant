// Ambient summary preference semantics — pure part lifted verbatim from
// proactive-ai-frontend/src/services/ambient/summary-preference.ts. The
// storage side stays per-platform (web localStorage, RN AsyncStorage); the
// platform wrapper loads its persisted value and passes it in explicitly
// (dev's version reads localStorage inline when ``preference`` is omitted —
// omitting here falls back to the same default). Dev keeps its own private
// copy for now (no consumer switch).
export type AmbientSummaryPreference = "cloud_when_unlocked" | "local_only";
export type AmbientSummaryEffectiveMode = "cloud_llm" | "local_llm";

export const DEFAULT_AMBIENT_SUMMARY_PREFERENCE: AmbientSummaryPreference = "cloud_when_unlocked";

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
  const preference = input.preference ?? DEFAULT_AMBIENT_SUMMARY_PREFERENCE;
  return preference === "local_only" ? "local_llm" : "cloud_llm";
}
