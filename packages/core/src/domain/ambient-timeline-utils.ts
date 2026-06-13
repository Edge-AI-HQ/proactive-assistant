/**
 * Pure text/hash helpers shared by the ambient outbox and (eventually) the
 * timeline pipeline. Lifted out of web services/ambient/timeline/utils.ts so
 * the ambient outbox can move to @pin-ai/core without dragging the whole
 * timeline module. When the timeline pipeline is later lifted, the rest of
 * utils.ts folds in here and the web file becomes a thin re-export.
 */

/** FNV-1a 32-bit hash to base36. Stable across runs/platforms. */
export function stableHash(value: string): string {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** Strip "Transcript segment:" labels and collapse whitespace. */
export function stripTranscriptSegmentLabels(value: string): string {
  return value
    .replace(/Transcript segment:\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
