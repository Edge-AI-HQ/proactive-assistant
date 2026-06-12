// RN 入口：polyfill 必须先于一切业务 import。
// - URL：supabase-js 依赖完整 URL/URLSearchParams，Hermes 不全。
// - TextDecoder：core 的 SSE 解析（transport/sse.ts）用 TextDecoder 流式
//   解码，Hermes 缺失时用 polyfill 兜底（条件加载，原生有则不覆盖）。
import "react-native-url-polyfill/auto";
// Hermes 的 TextDecoder 缺失时兜底（原生有则不覆盖）。
if (typeof globalThis.TextDecoder === "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- 条件 polyfill 只能 require
  require("fast-text-encoding");
}
// WebCrypto：Hermes 无 crypto 全家桶，用 expo-crypto 补齐消费到的三个面
// （都有真机实测的炸点，缺一不可）：
// - getRandomValues：supabase PKCE 生成 verifier（只挂 subtle 会让
//   supabase 误判 crypto 可用 → TypeError）
// - subtle.digest：PKCE S256 challenge（缺了静默降级 plain）
// - randomUUID：conversation sendMessage 的 clientMsgId（缺了发消息即炸）
import { digest, getRandomValues, randomUUID } from "expo-crypto";
const g = globalThis as {
  crypto?: {
    subtle?: { digest?: unknown };
    getRandomValues?: unknown;
    randomUUID?: unknown;
  };
};
if (!g.crypto) g.crypto = {};
if (!g.crypto.getRandomValues) {
  g.crypto.getRandomValues = getRandomValues;
}
if (!g.crypto.randomUUID) {
  g.crypto.randomUUID = randomUUID;
}
if (!g.crypto.subtle) {
  g.crypto.subtle = {
    digest: (algorithm: string, data: BufferSource) => digest(algorithm as never, data),
  };
}
import { registerRootComponent } from "expo";

import App from "./src/App";

registerRootComponent(App);
