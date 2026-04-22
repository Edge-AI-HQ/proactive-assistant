/**
 * Pure helpers for turning proactive-ai SSE events into assistant-ui
 * ChatModelRunResult content parts. Kept separate from the runtime hook so it
 * can be unit-tested without pulling the React / assistant-ui tree.
 *
 * Live events arrive interleaved: text deltas, tool-call starts, tool-call
 * results. `LiveContentBuilder` maintains an ordered parts list so the UI
 * renders text blocks and tool-activity rows in the same real order the
 * agent produced them (matching the reload path in chat-history-merge.ts).
 */

export interface ProactiveToolCallArgs {
  meta?: string;
  argsPreview?: string;
  pinCommand?: string;
  status: "running" | "ok" | "error";
}

export type ProactiveToolCallSnapshotArgs = Record<string, string>;

export type ProactiveContentPart =
  | { type: "text"; text: string }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      args: ProactiveToolCallSnapshotArgs;
      argsText: string;
      result?: { ok: boolean };
      isError?: boolean;
    };

interface ToolStart {
  toolCallId: string;
  toolName: string;
  meta?: string;
  argsPreview?: string;
  pinCommand?: string;
}

interface ToolComplete {
  toolCallId: string;
  isError: boolean;
  meta?: string;
}

function buildArgs(args: ProactiveToolCallArgs): ProactiveToolCallSnapshotArgs {
  const out: ProactiveToolCallSnapshotArgs = { status: args.status };
  if (args.meta) out.meta = args.meta;
  if (args.argsPreview) out.argsPreview = args.argsPreview;
  if (args.pinCommand) out.pinCommand = args.pinCommand;
  return out;
}

function toolPart(args: ProactiveToolCallArgs & { toolCallId: string; toolName: string }): ProactiveContentPart {
  const snapshotArgs = buildArgs({
    status: args.status,
    meta: args.meta,
    argsPreview: args.argsPreview,
    pinCommand: args.pinCommand,
  });
  const part: ProactiveContentPart = {
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
 *   - `openToolCall` closes the current text part (so a later `appendText`
 *     starts a new text part AFTER this tool).
 *   - `completeToolCall` updates the matching tool part in place without
 *     disturbing order or the text cursor.
 */
export class LiveContentBuilder {
  private readonly parts: ProactiveContentPart[] = [];
  /** Index of the text part currently open for append; -1 when none. */
  private openTextIdx = -1;
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

  openToolCall(step: ToolStart): void {
    if (this.toolIndex.has(step.toolCallId)) return;
    const idx = this.parts.length;
    this.parts.push(
      toolPart({
        toolCallId: step.toolCallId,
        toolName: step.toolName,
        meta: step.meta,
        argsPreview: step.argsPreview,
        pinCommand: step.pinCommand,
        status: "running",
      }),
    );
    this.toolIndex.set(step.toolCallId, idx);
    // Future text deltas should start a new text part after this tool.
    this.openTextIdx = -1;
  }

  completeToolCall(update: ToolComplete): void {
    const idx = this.toolIndex.get(update.toolCallId);
    if (idx === undefined) return;
    const slot = this.parts[idx];
    if (slot.type !== "tool-call") return;
    const status = update.isError ? "error" : "ok";
    const nextArgs: ProactiveToolCallSnapshotArgs = { ...slot.args, status };
    if (update.meta && !nextArgs.meta) nextArgs.meta = update.meta;
    this.parts[idx] = {
      ...slot,
      args: nextArgs,
      argsText: JSON.stringify(nextArgs),
      result: { ok: !update.isError },
      ...(update.isError ? { isError: true as const } : {}),
    };
  }

  /** Return a shallow-frozen copy for assistant-ui to render. */
  snapshot(): ProactiveContentPart[] {
    return this.parts.slice();
  }

  /**
   * Replace the entire text content while keeping tool parts. Used for
   * `chat:reply` finalization events that resend the full assistant text.
   */
  replaceText(fullText: string): void {
    const toolsOnly = this.parts.filter((p) => p.type === "tool-call");
    this.parts.length = 0;
    this.toolIndex.clear();
    this.openTextIdx = -1;
    for (const part of toolsOnly) {
      if (part.type === "tool-call") {
        this.toolIndex.set(part.toolCallId, this.parts.length);
        this.parts.push(part);
      }
    }
    if (fullText) {
      this.parts.push({ type: "text", text: fullText });
      this.openTextIdx = this.parts.length - 1;
    }
  }

  isEmpty(): boolean {
    return this.parts.length === 0;
  }
}
