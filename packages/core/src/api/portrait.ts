import { readErrorMessage } from "../transport/errors";
import { proxyFetch } from "../transport/http";

// ── L2 portrait (Mirror page) ─────────────────────────────────────────────
//
// The resident markdown portrait — six slots (IDENTITY/SOUL/TOOLS user-template
// + USER/MEMORY/GOALS agent-maintained). `GET /api/user-strings` returns each
// slot's content verbatim; the Mirror renders the markdown (entry blocks are
// `§`-delimited, see splitPortraitEntries). Read-only on the UI side — the
// portrait is agent-maintained, so there is no write path here.

/** Canonical slot names — mirrors the backend `_SLOTS` tuple. */
export type PortraitSlot =
  | "IDENTITY"
  | "SOUL"
  | "TOOLS"
  | "USER"
  | "MEMORY"
  | "GOALS";

export interface Portrait {
  /** Per-slot markdown content. Absent slots come back as "" from the server. */
  slots: Record<string, string>;
}

/** The `§` entry separator the backend slots use (see user_strings._SEP). */
const PORTRAIT_ENTRY_SEPARATOR = "§";

/**
 * Split a slot's markdown content into its individual entries. Mirrors the
 * backend `_split` (split on `§`, trim, drop empties) so the UI renders the
 * same entry boundaries the agent edits.
 */
export function splitPortraitEntries(content: string | undefined): string[] {
  if (!content) return [];
  return content
    .split(PORTRAIT_ENTRY_SEPARATOR)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export async function fetchPortrait(signal?: AbortSignal): Promise<Portrait> {
  // Trailing slash matches the backend route (`/api/user-strings/`, @router.get("/")
  // under prefix="/api/user-strings") — avoids a 307 redirect through the proxy.
  const res = await proxyFetch("/user-strings/", { signal });
  if (!res.ok) throw new Error(`/user-strings failed: ${await readErrorMessage(res)}`);
  const data = (await res.json()) as { slots?: Record<string, string> };
  return { slots: data.slots ?? {} };
}
