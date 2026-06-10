/**
 * Pure helpers for turning proactive-ai SSE events into the conversation
 * runtime's content parts. Kept separate from the runtime hook so it
 * can be unit-tested without pulling the React tree.
 *
 * Live events arrive interleaved: text deltas, tool-call starts, tool-call
 * results. `LiveContentBuilder` maintains an ordered parts list so the UI
 * renders text blocks and tool-activity rows in the same real order the
 * agent produced them (matching the reload path in chat-history-merge.ts).
 */

/** JSON value type. Used for the structured `input` payload so the tool-call
 *  part's args stay JSON-compatible end-to-end (backend sends JSON; the
 *  conversation runtime's tool-call part args are typed as JSON object). */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [k: string]: JsonValue };

export interface ToolCallArgs {
  meta?: string;
  argsPreview?: string;
  pinCommand?: string;
  status: "running" | "ok" | "error";
  /** Raw structured tool input (when JSON-serializable and under the
   *  backend's 8 KB cap). Threaded through from chat:tool:start's
   *  optional `args` field and from history.py's `args` field on
   *  tool-call parts. Components like ProposeActionCard read this to
   *  render specialized UI (chips + drafts + plan) instead of relying
   *  on the truncated argsPreview string. */
  input?: JsonValue;
}

/** Per-tool-call args dict surfaced to the conversation runtime's
 *  tool-call part renderer. Always JSON-serializable end-to-end. */
export type ToolCallSnapshotArgs = { [k: string]: JsonValue };

/** One clickable source from a web-search tool's structured results. */
export interface ToolResultLink {
  title: string;
  url: string;
}

export type ConversationContentPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      args: ToolCallSnapshotArgs;
      argsText: string;
      result?: { ok: boolean };
      isError?: boolean;
      /** The `task` call this nested subagent tool belongs to; absent on the
       *  orchestrator's own calls (renderer keeps the flat stream). */
      parentTaskId?: string;
      agentName?: string;
      /** Async LLM title backfilled onto a work group's anchor (first)
       *  tool-call part; absent groups keep the deterministic fallback. */
      groupTitle?: string;
      links?: ToolResultLink[];
    };

interface ToolStart {
  toolCallId: string;
  toolName: string;
  meta?: string;
  argsPreview?: string;
  pinCommand?: string;
  parentTaskId?: string;
  agentName?: string;
  /** Optional raw structured input — carried verbatim from the SSE
   *  `chat:tool:start` event's `args` field (full payload up to the
   *  8 KB cap in streaming.py). Tools with specialized UI renderers
   *  (propose_action → ProposeActionCard) read this; tools without
   *  one ignore it harmlessly. */
  input?: JsonValue;
}

interface ToolComplete {
  toolCallId: string;
  isError: boolean;
  meta?: string;
  links?: ToolResultLink[];
}

/** Defensive parse for the wire `links` payload (SSE + history share it). */
export function parseToolLinks(value: unknown): ToolResultLink[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: ToolResultLink[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const url = (item as { url?: unknown }).url;
    if (typeof url !== "string" || !url) continue;
    const title = (item as { title?: unknown }).title;
    out.push({ title: typeof title === "string" && title ? title : url, url });
  }
  return out.length ? out : undefined;
}

function buildArgs(args: ToolCallArgs): ToolCallSnapshotArgs {
  const out: ToolCallSnapshotArgs = { status: args.status };
  if (args.meta) out.meta = args.meta;
  if (args.argsPreview) out.argsPreview = args.argsPreview;
  if (args.pinCommand) out.pinCommand = args.pinCommand;
  if (args.input !== undefined) out.input = args.input;
  return out;
}

function toolPart(args: ToolCallArgs & { toolCallId: string; toolName: string }): ConversationContentPart {
  const snapshotArgs = buildArgs({
    status: args.status,
    meta: args.meta,
    argsPreview: args.argsPreview,
    pinCommand: args.pinCommand,
    input: args.input,
  });
  const part: ConversationContentPart = {
    type: "tool-call",
    toolCallId: args.toolCallId,
    toolName: args.toolName,
    args: snapshotArgs,
    argsText: JSON.stringify(snapshotArgs),
  };
  if (args.status !== "running") {
    part.result = { ok: args.status === "ok" };
    if (args.status === "error") part.isError = true;
  }
  return part;
}

/**
 * Maintains an ordered list of content parts as SSE events arrive.
 *
 * Contract:
 *   - Consecutive `appendText` calls fold into the current trailing text part.
 *   - Consecutive `appendReasoning` calls fold into the current trailing
 *     reasoning part. Reasoning and text are siblings in `parts` (matching
 *     Anthropic's actual block ordering: thinking arrives before answer).
 *   - `openToolCall` closes both text and reasoning so later deltas start a
 *     new part AFTER this tool.
 *   - `completeToolCall` updates the matching tool part in place without
 *     disturbing order or the open cursors.
 */
export class LiveContentBuilder {
  private readonly parts: ConversationContentPart[] = [];
  /** Index of the text part currently open for append; -1 when none. */
  private openTextIdx = -1;
  /** Index of the reasoning part currently open for append; -1 when none. */
  private openReasoningIdx = -1;
  /** toolCallId → index in `parts`, for O(1) result lookup. */
  private readonly toolIndex = new Map<string, number>();

  appendText(delta: string): void {
    if (!delta) return;
    if (this.openTextIdx >= 0) {
      const existing = this.parts[this.openTextIdx];
      if (existing.type === "text") {
        existing.text += delta;
        return;
      }
    }
    this.parts.push({ type: "text", text: delta });
    this.openTextIdx = this.parts.length - 1;
  }

  appendReasoning(delta: string): void {
    if (!delta) return;
    if (this.openReasoningIdx >= 0) {
      const existing = this.parts[this.openReasoningIdx];
      if (existing.type === "reasoning") {
        existing.text += delta;
        return;
      }
    }
    this.parts.push({ type: "reasoning", text: delta });
    this.openReasoningIdx = this.parts.length - 1;
  }

  openToolCall(step: ToolStart): void {
    if (this.toolIndex.has(step.toolCallId)) return;
    const idx = this.parts.length;
    const part = toolPart({
      toolCallId: step.toolCallId,
      toolName: step.toolName,
      meta: step.meta,
      argsPreview: step.argsPreview,
      pinCommand: step.pinCommand,
      input: step.input,
      status: "running",
    });
    if (part.type === "tool-call" && step.parentTaskId) {
      part.parentTaskId = step.parentTaskId;
      if (step.agentName) part.agentName = step.agentName;
    }
    this.parts.push(part);
    this.toolIndex.set(step.toolCallId, idx);
    // Future deltas should start fresh parts after this tool.
    this.openTextIdx = -1;
    this.openReasoningIdx = -1;
  }

  completeToolCall(update: ToolComplete): void {
    const idx = this.toolIndex.get(update.toolCallId);
    if (idx === undefined) return;
    const slot = this.parts[idx];
    if (slot.type !== "tool-call") return;
    const status = update.isError ? "error" : "ok";
    const nextArgs: ToolCallSnapshotArgs = { ...slot.args, status };
    if (update.meta && !nextArgs.meta) nextArgs.meta = update.meta;
    this.parts[idx] = {
      ...slot,
      args: nextArgs,
      argsText: JSON.stringify(nextArgs),
      result: { ok: !update.isError },
      ...(update.isError ? { isError: true as const } : {}),
      ...(update.links ? { links: update.links } : {}),
    };
  }

  /** Backfill the async LLM group title onto its anchor tool-call part.
   *  No-op for unknown anchors (e.g. annotation replayed without its group). */
  setGroupTitle(anchorToolCallId: string, title: string): void {
    const idx = this.toolIndex.get(anchorToolCallId);
    if (idx === undefined) return;
    const slot = this.parts[idx];
    if (slot.type !== "tool-call") return;
    this.parts[idx] = { ...slot, groupTitle: title };
  }

  /** Return a shallow copy of the ordered parts for the view to render. */
  snapshot(): ConversationContentPart[] {
    return this.parts.slice();
  }

  isEmpty(): boolean {
    return this.parts.length === 0;
  }
}
