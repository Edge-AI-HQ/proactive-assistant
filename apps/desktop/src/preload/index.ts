/**
 * Preload —— renderer 可用的桌面能力白名单（contextBridge）。
 *
 * 形状即 `window.pinaiDesktop`。renderer 侧的契约真源是 renderer（apps/web）
 * 经 @pin-ai/ui-web 消费的 packages/ui-web/src/auth/desktop-bridge.ts 的
 * `PinaiDesktopBridge`——web/Capacitor 构建下该对象不存在 → `isElectron`
 * 探测为 false，所有桌面分支天然关闭。改这里的契约要同步那个 interface
 * （proactive-ai-frontend/src/types/desktop-shell.d.ts 是 frontend 自用的
 * 同形副本，给它的 desktop-notifications 用，一并对齐）。
 * 能力面：OAuth（登录窗 + loopback）、同步引擎 db IPC（node:sqlite，
 * per-user 库）、窗口唤起（通知点击/快捷键）。
 */
import { contextBridge, ipcRenderer } from "electron";

const api = {
  platform: process.platform,
  /** 用系统浏览器打开 https URL（OAuth 起跳、外链）。 */
  openExternal(url: string): Promise<void> {
    return ipcRenderer.invoke("pinai:open-external", url);
  },
  /** 起一次性 OAuth loopback server，返回端口。回调经 onOpenUrl 到达。 */
  startOauthLoopback(): Promise<number> {
    return ipcRenderer.invoke("pinai:oauth-loopback");
  },
  /** 打开内嵌 OAuth 登录窗（回调到达即自动关闭）。 */
  openOauthWindow(url: string): Promise<void> {
    return ipcRenderer.invoke("pinai:oauth-window", url);
  },
  /** 同步引擎 driver：per-user 库上执行写语句（main 持 node:sqlite）。 */
  dbRun(dbName: string, sql: string, params: (string | number | null)[]): Promise<void> {
    return ipcRenderer.invoke("pinai:db-run", dbName, sql, params);
  },
  /** 同步引擎 driver：查询语句，返回行对象数组。 */
  dbQuery(
    dbName: string,
    sql: string,
    params: (string | number | null)[],
  ): Promise<Record<string, unknown>[]> {
    return ipcRenderer.invoke("pinai:db-query", dbName, sql, params);
  },
  /** 唤起主窗（通知点击）。 */
  showMainWindow(): Promise<void> {
    return ipcRenderer.invoke("pinai:show-window");
  },
  /** 订阅 OAuth deep link 回跳（`ai.pin.proactive.desktop://auth/callback?...`）。
   *  返回退订函数。 */
  onOpenUrl(callback: (url: string) => void): () => void {
    const listener = (_event: unknown, url: string) => callback(url);
    ipcRenderer.on("pinai:open-url", listener);
    return () => {
      ipcRenderer.removeListener("pinai:open-url", listener);
    };
  },
};

contextBridge.exposeInMainWorld("pinaiDesktop", api);

export type PinaiDesktopApi = typeof api;
