/**
 * Electron 桌面壳 preload API 的形状（apps/desktop/src/preload/index.ts 经
 * contextBridge 注入 window.pinaiDesktop）。这里用模块内 interface + 显式
 * 窄化 cast 访问，不做 ambient `declare global`——避免与
 * proactive-ai-frontend/src/types/desktop-shell.d.ts 的全局声明重复合并。
 * 两处形状必须保持一致；改 preload 契约时两边同步。
 */
export interface PinaiDesktopBridge {
  platform: string;
  openExternal(url: string): Promise<void>;
  startOauthLoopback(): Promise<number>;
  openOauthWindow(url: string): Promise<void>;
  dbRun(dbName: string, sql: string, params: (string | number | null)[]): Promise<void>;
  dbQuery(
    dbName: string,
    sql: string,
    params: (string | number | null)[],
  ): Promise<Record<string, unknown>[]>;
  showMainWindow(): Promise<void>;
  onOpenUrl(callback: (url: string) => void): () => void;
}

export function getDesktopBridge(): PinaiDesktopBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { pinaiDesktop?: PinaiDesktopBridge }).pinaiDesktop;
}
