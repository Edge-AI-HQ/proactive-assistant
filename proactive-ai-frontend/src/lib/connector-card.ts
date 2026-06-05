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
 * connector-guidance one and the OAuth flow ran; returns null when
 * the input wasn't recognized (caller falls back to its normal
 * confirm flow).
 */
import type { ComposioState } from "@/hooks/useComposio";
import type { IntentCard } from "@/types/intent-card";

import { openOAuthAndAwaitClose } from "./oauth-popup";
import { getToolkit } from "./toolkit-icons";

const CONNECT_PREFIX = "connect:";

export interface PreparedConnectorOAuth {
  canonicalSlug: string;
  redirectUrl?: string;
}

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

/** Return the canonical toolkit slug for a recognized connector card. */
export function canonicalConnectorSlugFromIntentKey(intentKey: string | undefined): string | null {
  const slug = connectorSlugFromIntentKey(intentKey);
  if (!slug) return null;
  return getToolkit(slug)?.canonicalSlug ?? null;
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
  options?: { awaitClose?: boolean },
): Promise<string | null> {
  const prepared = await prepareConnectorOAuth(slug, composio);
  if (!prepared) return null;
  await openPreparedConnectorOAuth(prepared, options);
  return prepared.canonicalSlug;
}

export async function prepareConnectorOAuth(
  slug: string,
  composio: ComposioState,
): Promise<PreparedConnectorOAuth | null> {
  const meta = getToolkit(slug);
  if (!meta) return null;
  try {
    const result = await composio.connectToolkit(meta.canonicalSlug);
    if (!result.ok) return null;
    return {
      canonicalSlug: meta.canonicalSlug,
      ...(result.redirectUrl ? { redirectUrl: result.redirectUrl } : {}),
    };
  } catch {
    // swallow — the chip / card already returned the user to flow
  }
  return null;
}

export async function openPreparedConnectorOAuth(
  prepared: PreparedConnectorOAuth,
  options?: { awaitClose?: boolean },
): Promise<void> {
  if (!prepared.redirectUrl) return;
  const closePromise = openOAuthAndAwaitClose(prepared.redirectUrl);
  if (options?.awaitClose === false) {
    void closePromise.catch(() => undefined);
    return;
  }
  await closePromise;
}

/**
 * Card-side entry point: if `card` is a connector-guidance card, run
 * OAuth and return the canonical slug; otherwise return null so the
 * caller can run its normal confirm flow (open chat thread, etc.).
 */
export async function tryHandleConnectorCard(
  card: Pick<IntentCard, "intentKey">,
  composio: ComposioState,
): Promise<string | null> {
  const canonicalSlug = canonicalConnectorSlugFromIntentKey(card.intentKey);
  if (!canonicalSlug) return null;
  const meta = getToolkit(canonicalSlug);
  if (!meta) return null;
  const prepared = await prepareConnectorOAuth(canonicalSlug, composio);
  if (!prepared) return null;
  await openPreparedConnectorOAuth(prepared, { awaitClose: false });
  return meta.canonicalSlug;
}
