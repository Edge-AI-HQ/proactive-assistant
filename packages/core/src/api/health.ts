import { getTransportConfig, resolveFetch } from "../transport/config";

// ── Health (liveness + local-dev branch label) ──
export interface HealthInfo {
  status: string;
  service: string;
  db?: string;
  /** Local-dev only: git branch of the worktree this backend runs on
   *  (Makefile-injected via docker-compose.override.yml). Lets the DebugPanel
   *  show which worktree a tunneled phone is hitting. Absent in prod. */
  dev_label?: string;
}

export async function fetchHealth(signal?: AbortSignal): Promise<HealthInfo> {
  // `/health` is mounted at the web root (not under /api) and needs no auth,
  // so a plain fetch is enough. baseUrl is "" in browser (same-origin,
  // nginx proxies /health) or the ngrok URL on native.
  const res = await resolveFetch()(`${getTransportConfig().baseUrl}/health`, {
    signal,
  });
  if (!res.ok) throw new Error(`/health failed: ${res.status}`);
  return res.json();
}
