/**
 * 桌面新卡通知（Electron only；其余平台 no-op——iOS 的卡片通知走 APNs
 * 服务端推送，不在这条链）。
 *
 * 事件源是同步引擎的 cards 镜像增量（`syncCards().newCardIds`，空库
 * bootstrap 轮不算新）——桌面端引擎常驻（关窗驻留 hide），后台也能收到。
 * 用 web Notification API：Electron renderer 自动桥到 macOS 通知中心；
 * 点击经 preload 唤起主窗。
 */
import type { DatabasePort } from "@pin-ai/core";
import { isElectron } from "../platform";

export async function notifyNewCards(
  db: DatabasePort,
  newCardIds: string[],
): Promise<void> {
  if (!isElectron || newCardIds.length === 0) return;
  if (typeof Notification === "undefined") return;
  try {
    if (Notification.permission === "default") {
      await Notification.requestPermission();
    }
    if (Notification.permission !== "granted") return;

    const placeholders = newCardIds.map(() => "?").join(",");
    const rows = await db.query(
      `SELECT payload_json FROM cards WHERE card_id IN (${placeholders})`,
      newCardIds,
    );
    const titles = rows.flatMap((r) => {
      try {
        const card = JSON.parse(String(r.payload_json)) as {
          title?: string;
          summary?: string;
        };
        return card.title ? [{ title: card.title, summary: card.summary ?? "" }] : [];
      } catch {
        return [];
      }
    });
    if (titles.length === 0) return;

    const notification =
      titles.length === 1
        ? new Notification(titles[0].title, { body: titles[0].summary })
        : new Notification(`${titles.length} new cards for you`, {
            body: titles
              .slice(0, 2)
              .map((t) => t.title)
              .join(" · "),
          });
    notification.onclick = () => {
      void window.pinaiDesktop?.showMainWindow();
    };
  } catch (err) {
    console.warn("[desktop-notify] failed (ignored):", err);
  }
}
