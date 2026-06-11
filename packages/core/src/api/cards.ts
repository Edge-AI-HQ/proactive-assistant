import { parseEntries, type VisibleCardEntry } from "../domain/cards";
import { proxyFetch } from "../transport/http";

/**
 * Cross-run card history (`GET /cards`) — the single read path for the
 * full card history backing ChatTimeline + NOW view. Response rows are
 * normalized via domain/cards.parseEntries (malformed rows dropped).
 */
export async function fetchCards(
  limit: number,
  signal?: AbortSignal,
): Promise<VisibleCardEntry[]> {
  const res = await proxyFetch(`/cards?limit=${encodeURIComponent(limit)}`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseEntries(await res.json());
}
