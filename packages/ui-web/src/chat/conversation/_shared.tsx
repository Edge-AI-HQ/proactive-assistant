/**
 * Shared primitives for the conversation transcript components: the action-bar
 * button styles, the feedback-channel context, and small pure helpers. Kept in
 * one leaf module so the entry components (UserEntry / AssistantEntry / …) can
 * depend on it without forming import cycles.
 */
import { createContext } from "react";
import type { ConversationContentPart } from "@pin-ai/core";
import { cn } from "../../lib/utils";

export const ACTION_BTN = cn(
  "inline-flex items-center justify-center w-7 h-7 rounded-lg",
  "text-foreground/40 hover:text-foreground/70 hover:bg-foreground/[0.06]",
  "transition-colors",
);
export const ACTION_BTN_ACTIVE = cn(
  "inline-flex items-center justify-center w-7 h-7 rounded-lg",
  "text-foreground bg-foreground/[0.08] transition-colors",
);

/** The feedback `channel` for the current conversation (main_chat /
 *  card_execution / proactive). ConversationView provides it so the action
 *  bar's 👍/👎 records which surface the feedback came from, without drilling
 *  the value through every transcript entry. */
export const FeedbackChannelContext = createContext<string>("main_chat");

/** Extract the agent's outreach text from a `notify_user` tool-call part's
 *  snapshot args (structured `input.message`, else the preview string). */
export function notifyUserText(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const root = raw as Record<string, unknown>;
  const inner =
    root.input && typeof root.input === "object"
      ? (root.input as Record<string, unknown>)
      : root;
  const msg = typeof inner.message === "string" ? inner.message.trim() : "";
  if (msg) return msg;
  const preview = typeof root.argsPreview === "string" ? root.argsPreview.trim() : "";
  return preview || null;
}

/** Wall-clock HH:MM AM/PM for a message timestamp. Returns null for an
 *  invalid / zero ts. */
export function formatClockTime(ts: number): string | null {
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const d = new Date(ts);
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m.toString().padStart(2, "0")} ${ampm}`;
}

/** Concatenated plain text of an assistant turn (for Copy). */
export function assistantPlainText(parts: ConversationContentPart[]): string {
  const texts: string[] = [];
  for (const p of parts) if (p.type === "text") texts.push(p.text);
  return texts.join("\n\n").trim();
}
