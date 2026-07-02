/**
 * Composio OAuth surface——web `ui-web/connect/oauth-popup.ts` 的 RN 介质版。
 * dev（Capacitor）走 `@capacitor/browser`（in-app browser + browserFinished 事件 +
 * 程序化 Browser.close()）；RN 等价 = `expo-web-browser`：
 * - `openBrowserAsync` 的 promise 在用户关掉 in-app browser 时 resolve（= browserFinished），
 *   同样补 3s grace 等 OAuth 回调落地；
 * - `dismissBrowser()` = Browser.close()——后端确认 ACTIVE 后主动收掉 Composio
 *   的 hosted“you can close this”页（它不会自己关）。
 */
import * as WebBrowser from "expo-web-browser";

/** 打开 OAuth URL，用户关掉浏览器（或被程序化 dismiss）后 +3s resolve。 */
export async function openOAuthAndAwaitClose(url: string): Promise<void> {
  await WebBrowser.openBrowserAsync(url, { presentationStyle: WebBrowser.WebBrowserPresentationStyle.POPOVER });
  await new Promise<void>((resolve) => setTimeout(resolve, 3000));
}

/** 程序化收掉最近打开的 OAuth in-app browser（无打开面时是 no-op）。 */
export async function closeOAuthSurface(): Promise<void> {
  WebBrowser.dismissBrowser();
}
