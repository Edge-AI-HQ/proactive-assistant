/**
 * Connector OAuth 编排(chip / 卡片内联入口用)——web ui-web/connect/
 * connector-card.ts 的 triggerConnectorOAuth 对应物,链路照抄本目录
 * DataConnections.handleConnect(connect → 并行 waitForToolkit(ACTIVE 后主动
 * closeOAuthSurface 收掉 Composio hosted 成功页)→ openOAuthAndAwaitClose →
 * loadConnections),减去 per-toolkit 的错误态 UI——内联 nudge 不渲染自己的
 * 进度面,错误吞掉让用户留在原流程(dev 同款取舍)。
 */
import { resolveToolkit } from "@pin-ai/core";
import type { ComposioState } from "@pin-ai/state";

import { closeOAuthSurface, openOAuthAndAwaitClose } from "./oauth-surface";

/**
 * 对 prompt 友好 slug(gmail / google_calendar / slack…)发起 OAuth。
 * 返回实际连接的 canonical slug;slug 不认识或 connect 失败返回 null
 * (调用方降级为 no-op)。
 */
export async function triggerConnectorOAuth(
  slug: string,
  composio: ComposioState,
): Promise<string | null> {
  const meta = resolveToolkit(slug);
  if (!meta) return null;
  try {
    const result = await composio.connectToolkit(meta.canonicalSlug);
    if (!result.ok) return null;
    if (!result.redirectUrl) {
      // 已连接的复用路径:无 OAuth 跳转,直接刷新连接列表。
      if (result.connectedAccountId) await composio.loadConnections();
      return meta.canonicalSlug;
    }
    if (result.connectedAccountId) {
      void composio
        .waitForToolkit(result.connectedAccountId)
        .then(async (waitResult) => {
          if (waitResult.connected) {
            // 后端已确认 ACTIVE:Composio hosted 成功页不会自己关,主动收掉。
            await closeOAuthSurface();
          }
          await composio.loadConnections();
        })
        .catch(() => undefined);
    }
    await openOAuthAndAwaitClose(result.redirectUrl);
    void composio.loadConnections();
    return meta.canonicalSlug;
  } catch {
    // swallow — the chip already returned the user to flow(dev 同款)。
    return null;
  }
}
