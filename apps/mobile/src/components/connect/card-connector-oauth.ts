/**
 * Connector-guidance card 的 OAuth 编排——web `ui-web/connect/connector-card.ts`
 * 的 RN 介质版（prepare + open 两段式，useCardActions 的 connect:* confirm
 * 短路用）。纯 slug 逻辑（canonicalConnectorSlugFromIntentKey /
 * PreparedConnectorOAuth）在 @pin-ai/core 共享；这里只做平台 IO glue：
 * composio.connectToolkit 换 redirectUrl → expo-web-browser 打开授权面
 * （oauth-surface.ts）。与 chat 侧 ConnectChip 可共用（card 前缀避免撞名）。
 */
import { resolveToolkit, type PreparedConnectorOAuth } from "@pin-ai/core";
import type { ComposioState } from "@pin-ai/state";

import { openOAuthAndAwaitClose } from "./oauth-surface";

/** web prepareConnectorOAuth 同构：slug → composio.connectToolkit → redirectUrl。
 *  未识别 slug / 连接失败 / 抛错 → null（调用方回滚乐观态）。 */
export async function prepareConnectorOAuth(
  slug: string,
  composio: ComposioState,
): Promise<PreparedConnectorOAuth | null> {
  const meta = resolveToolkit(slug);
  if (!meta) return null;
  try {
    const result = await composio.connectToolkit(meta.canonicalSlug);
    if (!result.ok) return null;
    return {
      canonicalSlug: meta.canonicalSlug,
      ...(result.redirectUrl ? { redirectUrl: result.redirectUrl } : {}),
    };
  } catch {
    // swallow — the card already returned the user to flow（web 同注释）
  }
  return null;
}

/** web openPreparedConnectorOAuth 同构：redirectUrl 缺失（已连接）= no-op；
 *  awaitClose:false 时后台打开、不等用户关掉授权面。 */
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
