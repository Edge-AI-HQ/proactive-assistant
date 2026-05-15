const SELECTED_AMBIENT_SUMMARY_MODEL_KEY = "pinai:ambient-models-selected-id";

export function getSelectedAmbientSummaryModelId(): string | null {
  try {
    const value = localStorage.getItem(SELECTED_AMBIENT_SUMMARY_MODEL_KEY);
    return value && value.trim().length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function setSelectedAmbientSummaryModelId(id: string): void {
  const normalized = id.trim();
  if (!normalized) return;
  localStorage.setItem(SELECTED_AMBIENT_SUMMARY_MODEL_KEY, normalized);
}

export function clearSelectedAmbientSummaryModelId(): void {
  try {
    localStorage.removeItem(SELECTED_AMBIENT_SUMMARY_MODEL_KEY);
  } catch {
    // ignore storage failures
  }
}
