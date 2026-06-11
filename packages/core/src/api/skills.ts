import { readErrorMessage } from "../transport/errors";
import { proxyFetch, proxyPost } from "../transport/http";

// ── v3 Skills (debug panel) ──────────────────────────────────────────────
//
// Response shape matches plugin `routes/skills.ts` which serves v3 `skill_index`
// rows plus the `SKILL.md` body on detail requests. See
// `docs/plans/memory-architecture.mdx` §三.

export type SkillStatus = "enabled" | "disabled" | "archived";

export interface Skill {
  id: string;
  title: string;
  description: string | null;
  status: SkillStatus;
  revision: number;
  body_hash: string;
  triggers: string[];
  source: string;
  created_run_id: string | null;
  last_updated_run_id: string | null;
  enabled_at: string | null;
  disabled_at: string | null;
  created_at: string;
  updated_at: string;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
  /** Only populated on detail (GET /skills/:id) and after create/update. */
  body?: string;
}

export interface SkillCreateInput {
  title: string;
  body: string;
  description?: string | null;
  triggers?: string[];
  status?: "enabled" | "disabled";
}

export interface SkillPatch {
  title?: string;
  description?: string | null;
  body?: string;
  triggers?: string[];
  status?: SkillStatus;
}

export async function fetchSkills(
  params?: { status?: SkillStatus; limit?: number },
  signal?: AbortSignal,
): Promise<{ ok: boolean; skills: Skill[] }> {
  const qs = new URLSearchParams();
  if (params?.status) qs.set("status", params.status);
  if (params?.limit) qs.set("limit", String(params.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const res = await proxyFetch(`/skills${suffix}`, { signal });
  if (!res.ok) throw new Error(`/skills failed: ${await readErrorMessage(res)}`);
  return res.json();
}

export async function fetchSkill(id: string, signal?: AbortSignal): Promise<{ ok: boolean; skill: Skill }> {
  const res = await proxyFetch(`/skills/${encodeURIComponent(id)}`, { signal });
  if (!res.ok) throw new Error(`/skills/${id} failed: ${await readErrorMessage(res)}`);
  return res.json();
}

export async function createSkill(input: SkillCreateInput): Promise<{ ok: boolean; skill: Skill }> {
  const res = await proxyPost("/skills", input);
  if (!res.ok) throw new Error(`create skill failed: ${await readErrorMessage(res)}`);
  return res.json();
}

export async function updateSkill(id: string, patch: SkillPatch): Promise<{ ok: boolean; skill: Skill }> {
  const res = await proxyFetch(`/skills/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`update skill failed: ${await readErrorMessage(res)}`);
  return res.json();
}

/** Soft delete — backend flips status to 'archived'. */
export async function archiveSkill(id: string): Promise<{ ok: boolean; skill: Skill }> {
  const res = await proxyFetch(`/skills/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`archive skill failed: ${await readErrorMessage(res)}`);
  return res.json();
}
