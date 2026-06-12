/**
 * Electron 桌面壳的 preload API 形状（apps/desktop/src/preload/index.ts
 * 经 contextBridge 注入）。web / Capacitor 构建下该对象不存在——
 * `lib/platform.ts` 的 `isElectron` 以此探测，桌面分支天然关闭。
 */
interface PinaiDesktopApi {
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

interface Window {
  pinaiDesktop?: PinaiDesktopApi;
}
