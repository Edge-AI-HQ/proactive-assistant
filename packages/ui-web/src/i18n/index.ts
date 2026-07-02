import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import type { SupportedGenerationLanguage } from "@pin-ai/core";

import { detectDeviceLanguage } from "./languages";

// en 全量静态打包 = 永远可用的回落层(缺 key / 加载失败都落到这)。
// 语料真源在 @pin-ai/ui-kit（双端共享层，RN 也要用）；vite alias 只映射包名到
// index.ts、不吃子路径，故照 tailwind 引 tokens.cjs 的先例走相对路径。
import account from "../../../ui-kit/src/locales/en/account.json";
import ambient from "../../../ui-kit/src/locales/en/ambient.json";
import auth from "../../../ui-kit/src/locales/en/auth.json";
import browser from "../../../ui-kit/src/locales/en/browser.json";
import card from "../../../ui-kit/src/locales/en/card.json";
import chat from "../../../ui-kit/src/locales/en/chat.json";
import common from "../../../ui-kit/src/locales/en/common.json";
import connect from "../../../ui-kit/src/locales/en/connect.json";
import onboarding from "../../../ui-kit/src/locales/en/onboarding.json";
import profile from "../../../ui-kit/src/locales/en/profile.json";
import tasks from "../../../ui-kit/src/locales/en/tasks.json";
import voice from "../../../ui-kit/src/locales/en/voice.json";

export const EN_RESOURCES = {
  account,
  ambient,
  auth,
  browser,
  card,
  chat,
  common,
  connect,
  onboarding,
  profile,
  tasks,
  voice,
} as const;

void i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  defaultNS: "common",
  ns: Object.keys(EN_RESOURCES),
  resources: { en: EN_RESOURCES },
  interpolation: { escapeValue: false }, // React 自身已做 XSS 转义
  react: { useSuspense: false },
  returnNull: false,
});

// 非 en 语言按需动态加载(vite 切 chunk,不进主 bundle)
const localeModules = import.meta.glob<{ default: Record<string, unknown> }>(
  "../../../ui-kit/src/locales/*/*.json",
);

/**
 * 切换 UI 语言:先确保该语言的翻译 bundle 已加载,再 changeLanguage。
 * 加载失败不抛错——i18next 的 fallbackLng 会兜底显示英文。
 */
export async function loadAndSwitchLanguage(
  lang: SupportedGenerationLanguage,
): Promise<void> {
  if (lang !== "en" && !i18n.hasResourceBundle(lang, "common")) {
    const entries = Object.entries(localeModules).filter(([path]) =>
      path.includes(`/locales/${lang}/`),
    );
    await Promise.allSettled(
      entries.map(async ([path, load]) => {
        const ns = path.split("/").pop()?.replace(".json", "") ?? "";
        const mod = await load();
        i18n.addResourceBundle(lang, ns, mod.default, true, true);
      }),
    );
  }
  await i18n.changeLanguage(lang);
  document.documentElement.lang = lang;
}

// 首屏(未登录)跟设备语言;登录后 useUiLanguageSync 以 settings 覆盖。
// 放共享 init 里 → mobile + apps/web 两端首屏一致跟设备语言。
void loadAndSwitchLanguage(detectDeviceLanguage());

export default i18n;
