/**
 * Connector ingest: subagent runs `pin` + Composio read tools.
 * Primary path: subagent writes `connector_raw_data` + profile via CLI (`connector-raw append`, facts/memory/update).
 * Legacy: assistant may still return `connector_history_batches` / JSON patch for the host to merge.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { CoreContext } from "../../core/context.js";
import {
  addMemory,
  appendConnectorRawData,
  setFact,
  setPreference,
  updateProfile,
} from "../../core/domains/profile/service.js";
import {
  detectAgentErrorInMessages,
  parseAgentJson,
} from "../pipeline/agent-output.js";

/** Cold subagent + pin + Composio can exceed 3m on slow machines. */
const PROFILE_INGEST_TIMEOUT_MS = 300_000;

/** One bounded fetch result to persist before profile merge. */
export interface ConnectorHistoryBatch {
  toolkit: string;
  tool_slug?: string;
  window_label?: string;
  /** Composio connected account id when known (optional). */
  connected_account_id?: string;
  /** JSON text from pin exec (object/array stringified); host may truncate. */
  records_json: string;
}

/** Full JSON object the subagent may return (history + profile deltas). */
export type ProfileIngestPayload = ProfileIngestPatch & {
  connector_history_batches?: ConnectorHistoryBatch[];
};

export interface ProfileIngestPatch {
  evidence_summary?: string;
  facts_delta?: Record<string, unknown>;
  preferences_delta?: Record<string, unknown>;
  memory_candidates?: Array<{ kind?: string; text: string; tags?: string[] }>;
  profile_summary_update?: string;
}

export interface ProfileIngestAgentInput {
  toolkit?: string | null;
  maxRecords: number;
  /**
   * Align with HTTP `apply`: when false, subagent must not run mutating profile / connector-raw pin commands (dry-run).
   */
  persistToProfile: boolean;
}

function extractAssistantText(messages: unknown[]): string {
  const list = messages as Array<{ role?: string; content?: unknown }>;
  const assistant = [...list].reverse().find((m) => m.role === "assistant");
  if (!assistant?.content) return "";
  if (typeof assistant.content === "string") return assistant.content.trim();
  if (Array.isArray(assistant.content)) {
    return (assistant.content as Array<{ type?: string; text?: string }>)
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text ?? "")
      .join("\n")
      .trim();
  }
  return "";
}

function buildProfileIngestSystemPrompt(
  input: ProfileIngestAgentInput,
): string {
  const toolkitLine = input.toolkit?.trim()
    ? `User asked to focus on toolkit: **${input.toolkit.trim()}** (still list connections to resolve connectedAccountId if needed).`
    : "Infer the best toolkit(s) from active connections; prefer one connector per run.";

  const dryRunBlock = input.persistToProfile
    ? ""
    : `
**Dry-run (persistToProfile=false):** Do **not** mutate the local DB — no \`pin profile connector-raw append\`, no \`pin profile facts set\`, no \`pin profile preferences set\`, no \`pin profile memory add\`, no \`pin profile update\` that changes data. Read-only commands are OK (e.g. \`pin personal connections list\`, \`pin profile get\`, tools search/schema). End with a short plain summary of what you would persist when apply runs.`;

  const persistBlock = input.persistToProfile
    ? `
5. **Persist raw reads (required when any \`pin personal exec\` returned data):** after each meaningful read, append a **bounded** JSON blob with \`pin profile connector-raw append\` (prefer \`printf ... | ... --stdin\` or \`--payload-file\`; max **512 KiB** per row). Never paste large raw JSON in chat.

6. **Update profile via CLI (same run):** from the same evidence, write stable fields with \`pin profile facts set --key ... --value-json '...'\`, \`pin profile preferences set ...\`, short bullets via \`pin profile memory add --kind connector_ingest --text '...' --tags-json '[\"gmail\"]'\`, and refresh one-line summary with \`pin profile update --id default --summary '...'\` when appropriate. Keep values small; do not dump full tool payloads into \`--text\`.

7. **Final assistant message:** one short line is enough (e.g. \`{"ok":true,"note":"persisted via pin CLI"}\` or plain \`done\`). The host **does not** require a JSON patch — DB updates must already have happened through \`pin\`.`
    : "";

  return `You are running a **connector profile-ingest** task inside Proactive AI.

Use \`pin\` via your exec/shell tool only — do not invent tool parameter names (always load schema first).

${toolkitLine}
${dryRunBlock}

Hard limits:
- When calling Composio-backed tools via \`pin personal exec\`, keep **max_results / limit / page size ≤ ${input.maxRecords}**.
- Prefer **read** tools only (list/fetch/search/get). No send/delete/pay/write.

Workflow (must actually run pin commands before concluding):
1. \`pin personal connections list --json\` — pick ACTIVE connector(s).
2. \`pin personal tools search --query "<natural language for historical read>" --json\` (add \`--toolkit\` if focusing one connector).
3. \`pin personal tools schema --name <SLUG> --json\` then \`pin personal exec --tool <SLUG> --input '<json>' --json\` (use \`--account-id\` when multiple accounts exist).
4. \`pin profile get --id default --json\` — see current summary/facts shape.
${persistBlock}

**Legacy (optional):** you may still return a compact JSON object with \`facts_delta\` / \`memory_candidates\` / \`profile_summary_update\` for hosts that merge server-side — but **prefer CLI writes** above so nothing large goes through the model context.`;
}

export interface ProfileIngestAgentResult {
  /** Parsed profile deltas (no connector_history_batches). Null = assistant JSON not parseable. */
  patch: ProfileIngestPatch | null;
  historyBatches: ConnectorHistoryBatch[];
  rawText: string;
  /** Subagent run finished ok and transcript had no tool error (DB may already be updated via pin CLI). */
  subagentCompleted: boolean;
}

export function profilePatchHasWork(p: ProfileIngestPatch): boolean {
  if (p.evidence_summary?.trim()) return true;
  if (p.facts_delta && Object.keys(p.facts_delta).length > 0) return true;
  if (p.preferences_delta && Object.keys(p.preferences_delta).length > 0)
    return true;
  if (Array.isArray(p.memory_candidates) && p.memory_candidates.length > 0)
    return true;
  if (p.profile_summary_update?.trim()) return true;
  return false;
}

/** Split persisted history vs profile patch for apply order. */
export function splitProfileIngestPayload(
  value: ProfileIngestPayload | Record<string, unknown> | null,
): { historyBatches: ConnectorHistoryBatch[]; patch: ProfileIngestPatch } {
  if (!value || typeof value !== "object") {
    return { historyBatches: [], patch: {} };
  }
  const obj = value as Record<string, unknown>;
  const batchesRaw = obj.connector_history_batches;
  const historyBatches: ConnectorHistoryBatch[] = [];
  if (Array.isArray(batchesRaw)) {
    for (const item of batchesRaw) {
      if (!item || typeof item !== "object") continue;
      const b = item as Record<string, unknown>;
      const toolkit = typeof b.toolkit === "string" ? b.toolkit.trim() : "";
      const records_json =
        typeof b.records_json === "string" ? b.records_json.trim() : "";
      if (!toolkit || !records_json) continue;
      const connected =
        typeof b.connected_account_id === "string"
          ? b.connected_account_id.trim()
          : undefined;
      historyBatches.push({
        toolkit,
        connected_account_id: connected || undefined,
        tool_slug:
          typeof b.tool_slug === "string" ? b.tool_slug.trim() : undefined,
        window_label:
          typeof b.window_label === "string"
            ? b.window_label.trim()
            : undefined,
        records_json,
      });
    }
  }
  const { connector_history_batches: _omit, ...rest } = obj;
  return { historyBatches, patch: rest as ProfileIngestPatch };
}

export async function runProfileIngestAgent(
  api: OpenClawPluginApi,
  input: ProfileIngestAgentInput,
): Promise<ProfileIngestAgentResult> {
  if (!api.runtime?.subagent) {
    throw new Error("Profile ingest trial requires runtime subagent (gateway)");
  }

  const sessionKey = `agent:profile-ingest:proactive-ai:${Date.now().toString(36)}`;
  const extraSystemPrompt = buildProfileIngestSystemPrompt(input);

  const persistHint = input.persistToProfile
    ? "Persist: after each read use `pin profile connector-raw append` (stdin/file), then update profile with `pin profile facts set` / `preferences set` / `memory add` / `profile update --summary` as needed. Final reply can be a single short line — the host does not need a JSON patch."
    : "Dry-run: read-only pin commands only; do not write connector_raw_data or profile.";

  const { runId } = await api.runtime.subagent.run({
    sessionKey,
    extraSystemPrompt,
    idempotencyKey: `proactive-ai:profile-ingest:${Date.now().toString(36)}`,
    message: `Run connector profile-ingest. ${persistHint}`,
    deliver: false,
  });

  try {
    const result = await api.runtime.subagent.waitForRun({
      runId,
      timeoutMs: PROFILE_INGEST_TIMEOUT_MS,
    });
    if (result.status !== "ok") {
      throw new Error(
        `Profile ingest subagent failed status=${result.status}${result.error ? ` error=${result.error}` : ""}`,
      );
    }
    const { messages } = await api.runtime.subagent.getSessionMessages({
      sessionKey,
      limit: 30,
    });
    const messageError = detectAgentErrorInMessages(messages);
    if (messageError) {
      throw new Error(`Profile ingest subagent: ${messageError}`);
    }
    const rawText = extractAssistantText(messages);
    const parsed = parseAgentJson<ProfileIngestPayload>(rawText);
    if (!parsed) {
      return {
        patch: null,
        historyBatches: [],
        rawText,
        subagentCompleted: true,
      };
    }
    const { historyBatches, patch: splitPatch } =
      splitProfileIngestPayload(parsed);
    const patch = profilePatchHasWork(splitPatch) ? splitPatch : null;
    return { patch, historyBatches, rawText, subagentCompleted: true };
  } finally {
    await api.runtime.subagent
      .deleteSession({ sessionKey, deleteTranscript: false })
      .catch(() => {});
  }
}

const MAX_HISTORY_BATCHES = 20;
const MAX_RECORDS_JSON_CHARS = 20_000;

const MAX_DELTA_KEYS = 32;

export interface ApplyConnectorHistoryResult {
  storedRawDataIds: string[];
}

/**
 * Persist connector read-tool payloads into `connector_raw_data` (before profile patch).
 */
export async function applyConnectorHistoryBatches(
  ctx: CoreContext,
  batches: ConnectorHistoryBatch[],
): Promise<ApplyConnectorHistoryResult> {
  const storedRawDataIds: string[] = [];
  const slice = batches.slice(0, MAX_HISTORY_BATCHES);
  for (const raw of slice) {
    const toolkit = raw.toolkit.trim();
    let records_json = raw.records_json.trim();
    if (!toolkit || !records_json) continue;
    if (records_json.length > MAX_RECORDS_JSON_CHARS) {
      records_json =
        records_json.slice(0, MAX_RECORDS_JSON_CHARS) + "\n/* truncated */";
    }
    const capturedAt = new Date().toISOString();
    const toolSlug = raw.tool_slug?.trim() ?? "";
    const windowLabel = raw.window_label?.trim() ?? "";
    const connectedAccountId = raw.connected_account_id?.trim() ?? "";
    const row = await appendConnectorRawData(ctx, {
      toolkit,
      toolSlug: toolSlug || undefined,
      windowLabel: windowLabel || undefined,
      connectedAccountId: connectedAccountId || undefined,
      capturedAt,
      payloadJson: records_json,
      ingestSource: "profile_ingest",
    });
    if (row?.id) {
      storedRawDataIds.push(row.id);
    }
  }
  return { storedRawDataIds };
}

function assertSafePatch(patch: ProfileIngestPatch): void {
  const keys = (o: Record<string, unknown> | undefined) =>
    o ? Object.keys(o).length : 0;
  if (
    keys(patch.facts_delta) > MAX_DELTA_KEYS ||
    keys(patch.preferences_delta) > MAX_DELTA_KEYS
  ) {
    throw new Error(
      `Patch too large: max ${MAX_DELTA_KEYS} keys per facts_delta / preferences_delta`,
    );
  }
}

export interface ApplyProfileIngestPatchResult {
  appliedFacts: string[];
  appliedPreferences: string[];
  memoryIds: string[];
  summaryUpdated: boolean;
}

/** Apply a validated patch to default profile. Caller must catch CoreError. */
export async function applyProfileIngestPatch(
  ctx: CoreContext,
  patch: ProfileIngestPatch,
): Promise<ApplyProfileIngestPatchResult> {
  assertSafePatch(patch);
  const appliedFacts: string[] = [];
  const appliedPreferences: string[] = [];
  const memoryIds: string[] = [];
  let summaryUpdated = false;

  if (patch.facts_delta) {
    for (const [key, value] of Object.entries(patch.facts_delta)) {
      if (!key.trim()) continue;
      await setFact(ctx, {
        key: key.trim(),
        valueJson: JSON.stringify(value),
      });
      appliedFacts.push(key.trim());
    }
  }

  if (patch.preferences_delta) {
    for (const [key, value] of Object.entries(patch.preferences_delta)) {
      if (!key.trim()) continue;
      await setPreference(ctx, {
        key: key.trim(),
        valueJson: JSON.stringify(value),
      });
      appliedPreferences.push(key.trim());
    }
  }

  if (Array.isArray(patch.memory_candidates)) {
    for (const row of patch.memory_candidates) {
      const text = typeof row.text === "string" ? row.text.trim() : "";
      if (!text) continue;
      const kind =
        typeof row.kind === "string" && row.kind.trim()
          ? row.kind.trim()
          : "connector_ingest";
      const tagsJson =
        Array.isArray(row.tags) && row.tags.length > 0
          ? JSON.stringify(row.tags)
          : undefined;
      const entry = await addMemory(ctx, { kind, text, tagsJson });
      if (entry && typeof entry.id === "string") {
        memoryIds.push(entry.id);
      }
    }
  }

  if (
    typeof patch.profile_summary_update === "string" &&
    patch.profile_summary_update.trim()
  ) {
    await updateProfile(ctx, {
      id: "default",
      summary: patch.profile_summary_update.trim(),
    });
    summaryUpdated = true;
  }

  return { appliedFacts, appliedPreferences, memoryIds, summaryUpdated };
}
