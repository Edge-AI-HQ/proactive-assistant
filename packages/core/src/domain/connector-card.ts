/**
 * Connector-guidance card 的纯 slug 逻辑(intent_key="connect:<slug>")。平台无关,
 * web / RN 共用。OAuth 编排(connectToolkit + 打开授权面)是 composio(state)+
 * 平台 IO(web 弹窗 / RN in-app browser)glue,留在各端
 * (web: ui-web/connect/connector-card)。
 */
import type { IntentCard } from "./intent-card";
import { resolveToolkit } from "./connector-toolkit";

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
  return resolveToolkit(slug)?.canonicalSlug ?? null;
}
