/**
 * Connector OAuth 编排:把 connector-guidance card / chip 转成实际 OAuth 流程。
 * 用 composio(state)+ oauth-popup(web/Capacitor IO)+ toolkit 注册表。属平台 IO
 * glue,留 ui-web —— 等 RN 做连接器时再抽 oauth port(用真适配器验证 port 形状)。
 *
 * 纯 slug 逻辑(isConnectorCard / connectorSlugFromIntentKey /
 * canonicalConnectorSlugFromIntentKey + PreparedConnectorOAuth)已下沉 @pin-ai/core
 * (domain/connector-card),web / RN 共用;下方 re-export 保旧路径。
 */
import type { IntentCard } from "@pin-ai/core";
import { canonicalConnectorSlugFromIntentKey, type PreparedConnectorOAuth } from "@pin-ai/core";
import type { ComposioState } from "@pin-ai/state";

import { openOAuthAndAwaitClose } from "./oauth-popup";
import { getToolkit } from "./toolkit-icons";

export {
  isConnectorCard,
  connectorSlugFromIntentKey,
  canonicalConnectorSlugFromIntentKey,
  type PreparedConnectorOAuth,
} from "@pin-ai/core";

/**
 * Kick off OAuth for a given prompt-friendly slug (e.g. "google_calendar",
 * "gmail", "slack"). Mirrors what `DataConnections.tsx`'s `handleConnect`
 * does, minus the per-toolkit error-state UI — connector nudges live inline
 * in cards/chat and intentionally don't render their own progress surface.
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
 * Card-side entry point: if `card` is a connector-guidance card, run OAuth and
 * return the canonical slug; otherwise return null so the caller can run its
 * normal confirm flow (open chat thread, etc.).
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
