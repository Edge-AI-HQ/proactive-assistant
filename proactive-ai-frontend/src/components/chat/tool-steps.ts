/**
 * Pure helpers for turning proactive-ai tool events into assistant-ui
 * ChatModelRunResult content parts. Kept separate from the runtime hook so it
 * can be unit-tested without pulling the React / assistant-ui tree.
 */

export interface ProactiveToolCallArgs {
  meta?: string;
  argsPreview?: string;
  pinCommand?: string;
  status: "running" | "ok" | "error";
}

export interface ProactiveToolStep {
  toolCallId: string;
  toolName: string;
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

export function toolStepArgs(step: ProactiveToolStep): ProactiveToolCallSnapshotArgs {
  const args: ProactiveToolCallSnapshotArgs = { status: step.status };
  if (step.meta) args.meta = step.meta;
  if (step.argsPreview) args.argsPreview = step.argsPreview;
  if (step.pinCommand) args.pinCommand = step.pinCommand;
  return args;
}

export function buildContentSnapshot(
  toolSteps: readonly ProactiveToolStep[],
  text: string,
): ProactiveContentPart[] {
  const parts: ProactiveContentPart[] = toolSteps.map((step) => {
    const args = toolStepArgs(step);
    const part: ProactiveContentPart = {
      type: "tool-call",
      toolCallId: step.toolCallId,
      toolName: step.toolName,
      args,
      argsText: JSON.stringify(args),
    };
    if (step.status !== "running") {
      part.result = { ok: step.status === "ok" };
      if (step.status === "error") part.isError = true;
    }
    return part;
  });
  parts.push({ type: "text", text });
  return parts;
}
