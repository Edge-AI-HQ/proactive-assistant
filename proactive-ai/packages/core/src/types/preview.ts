/**
 * Dry-run preview types.
 *
 * Core services can return a WritePreview to describe what WOULD happen
 * without actually executing. CLI wraps this into a dryRunEnvelope.
 */

export interface WritePreview {
  operation: "INSERT" | "UPDATE" | "DELETE";
  table: string;
  data: Record<string, unknown>;
}
