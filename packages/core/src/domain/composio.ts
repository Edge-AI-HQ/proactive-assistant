/**
 * Composio connector domain — toolkit-matching logic + shared wire types.
 *
 * SSOT for web (the useComposio hook) and RN (the Connect screen). The fanout
 * map + `composioToolkitCovers` decide whether a connected account satisfies a
 * target toolkit; web owned this while RN ConnectScreen hard-coded exact-match
 * — a drift waiting to happen, now collapsed here.
 */

/**
 * Backend-stable id of the per-(toolkit, connectedAccount) connector.init row
 * in `pai_scheduled_tasks`. Both /composio/connect→/wait and /composio/reconnect
 * upsert this same id, so the frontend can reconstruct it without threading a
 * server-returned task id through component state.
 *
 * Must stay in lockstep with `init_task_id()` in
 * backend/src/pinai_agents/web/routes/ui/composio.py.
 */
export function buildConnectorInitTaskId(toolkit: string, connectedAccountId: string): string {
  return `init.${toolkit.toLowerCase()}.${connectedAccountId}`;
}

/**
 * Backend-stable id of the onboarding-only connector.preview row. Unlike
 * connector.init, this task owns just the first small pull + summary cache.
 */
export function buildConnectorPreviewTaskId(toolkit: string, connectedAccountId: string): string {
  return `preview.${toolkit.toLowerCase()}.${connectedAccountId}`;
}

/** Toolkits that a single "super" connection fans out to cover. */
export const TOOLKIT_FANOUT: Record<string, string[]> = {
  googlesuper: ["gmail", "googlecalendar", "googledrive", "googledocs", "googlesheets"],
};

export function normalizeComposioToolkit(toolkit: string): string {
  return toolkit.trim().toLowerCase().replace(/[-_\s]/g, "");
}

export function composioToolkitCovers(connectionToolkit: string, targetToolkit: string): boolean {
  const connection = normalizeComposioToolkit(connectionToolkit);
  const target = normalizeComposioToolkit(targetToolkit);
  return connection === target || (TOOLKIT_FANOUT[connection] ?? []).includes(target);
}

export function getComposioConnectionsForToolkit<T extends { toolkit: string; status?: string }>(
  connections: T[],
  toolkit: string,
): T[] {
  const target = normalizeComposioToolkit(toolkit);
  return connections
    .filter((conn) => conn.status === "ACTIVE" && composioToolkitCovers(conn.toolkit, target))
    .sort((a, b) => {
      const aExact = normalizeComposioToolkit(a.toolkit) === target ? 0 : 1;
      const bExact = normalizeComposioToolkit(b.toolkit) === target ? 0 : 1;
      return aExact - bExact;
    });
}

export function isComposioToolkitConnected<T extends { toolkit: string; status?: string }>(
  connections: T[],
  toolkit: string,
): boolean {
  return getComposioConnectionsForToolkit(connections, toolkit).length > 0;
}

// ── Shared wire types ────────────────────────────────────────────────────

export interface ComposioConnection {
  toolkit: string;
  status: string;
  connectedAccountId: string | null;
  /** Backend-resolved display label (email / username / etc.). Always populated
   *  post-migration 040; backend falls back to a stable
   *  "toolkit (...{cid-suffix})" string if the identity action failed. */
  label: string | null;
  userInfo: Record<string, unknown> | null;
}

export interface ComposioStatus {
  /** True when the backend has a master Composio key configured. The key itself
   *  never reaches the browser — composio is multi-tenant on a single org-level
   *  key, scoped per user via Composio's user_id field. */
  configured: boolean;
  keyPrefix?: string;
}
