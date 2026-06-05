/**
 * Shared "kick off OAuth from a connector-guidance surface" helper.
 *
 * Both surfaces that nudge the user to connect a Composio data source
 * call into here so they behave identically:
 *   - A `connect:<slug>` intent card's primary action (handled by the
 *     three card-confirm sites: ChatTimeline, AppShell, useCardActions).
 *   - The inline `<ConnectChip>` rendered when assistant chat text
 *     contains a literal `[connect:<slug>]` tag.
 *
 * Returns the canonical Composio slug if the card / chip was a
 * connector-guidance one and the OAuth flow was kicked off; returns
 * null when the input wasn't recognized (caller falls back to its
 * normal confirm flow).
 */
import type { ComposioState } from "@/hooks/useComposio";
import type { IntentCard } from "@/types/intent-card";

import { openOAuthAndAwaitClose } from "./oauth-popup";
import { getToolkit } from "./toolkit-icons";

const CONNECT_PREFIX = "connect:";

/** True if this card is a connector-guidance card (intent_key="connect:<slug>"). */
export function isConnectorCard(card: Pick<IntentCard, "intentKey">): boolean {
  const key = card.intentKey;
  return typeof key === "string" && key.startsWith(CONNECT_PREFIX);
}

/** Extract the slug from an intent_key like "connect:google_calendar"; null when not a connector card. */
export function connectorSlugFromIntentKey(intentKey: string | undefined): string | null {
  if (!intentKey || !intentKey.startsWith(CONNECT_PREFIX)) return null;
  return intentKey.slice(CONNECT_PREFIX.length);
}

/**
 * Kick off OAuth for a given prompt-friendly slug (e.g. "google_calendar",
 * "gmail", "slack"). Mirrors what `DataConnections.tsx`'s `handleConnect`
 * does, minus the per-toolkit error-state UI — connector nudges live
 * inline in cards/chat and intentionally don't render their own progress
 * surface; settings page is the single place that polls and reports
 * init-task progress.
 *
 * Returns the canonical slug we attempted, or null if the slug wasn't
 * recognized (caller should degrade to "no-op" or fall through).
 */
export async function triggerConnectorOAuth(
  slug: string,
  composio: ComposioState,
): Promise<string | null> {
  const meta = getToolkit(slug);
  if (!meta) return null;
  try {
    const result = await composio.connectToolkit(meta.canonicalSlug);
    if (result.ok && result.redirectUrl) {
      await openOAuthAndAwaitClose(result.redirectUrl);
    }
    // No error toast here: nudges are best-effort. Connection list
    // refresh happens via DataConnections / useComposio's own poll.
  } catch {
    // swallow — the chip / card already returned the user to flow
  }
  return meta.canonicalSlug;
}

/**
 * Card-side entry point: if `card` is a connector-guidance card, kick
 * off OAuth and return the canonical slug; otherwise return null so
 * the caller can run its normal confirm flow (open chat thread, etc.).
 */
export function tryHandleConnectorCard(
  card: Pick<IntentCard, "intentKey">,
  composio: ComposioState,
): string | null {
  const slug = connectorSlugFromIntentKey(card.intentKey);
  if (!slug) return null;
  const meta = getToolkit(slug);
  if (!meta) return null;
  // Fire and forget — handleConfirm / useCardActions update card state
  // (mark done, post feedback) synchronously alongside this call.
  void triggerConnectorOAuth(slug, composio);
  return meta.canonicalSlug;
}
