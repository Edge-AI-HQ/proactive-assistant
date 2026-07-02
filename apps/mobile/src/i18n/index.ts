/**
 * RN i18n 入口 —— web `ui-web/src/i18n/index.ts` 的 RN 对应物。
 * 介质差异：web 用 vite import.meta.glob 懒加载非 en 语言（切 chunk）；Metro 是
 * 单体 bundle、无 glob → 8 语言 × 12 namespace 全部静态打包（语料共 ~724KB 源文件，
 * 对 dev bundle ~19MB 无感）。语料真源 = @pin-ai/ui-kit（相对路径引——vite/metro
 * 的包名 alias 只映射到 index.ts 不吃子路径，照 tailwind 引 tokens.cjs 的先例）。
 * 首屏语言跟 iOS 设备语言（bare RN 自带 SettingsManager，零新原生依赖）；
 * 登录后 useUiLanguageSync 以 settings.generationLanguage 覆盖（= dev 行为）。
 */
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { NativeModules } from "react-native";
import {
  matchSupportedLanguage,
  type SupportedGenerationLanguage,
} from "@pin-ai/core";

import en_account from "../../../../packages/ui-kit/src/locales/en/account.json";
import en_ambient from "../../../../packages/ui-kit/src/locales/en/ambient.json";
import en_auth from "../../../../packages/ui-kit/src/locales/en/auth.json";
import en_browser from "../../../../packages/ui-kit/src/locales/en/browser.json";
import en_card from "../../../../packages/ui-kit/src/locales/en/card.json";
import en_chat from "../../../../packages/ui-kit/src/locales/en/chat.json";
import en_common from "../../../../packages/ui-kit/src/locales/en/common.json";
import en_connect from "../../../../packages/ui-kit/src/locales/en/connect.json";
import en_onboarding from "../../../../packages/ui-kit/src/locales/en/onboarding.json";
import en_profile from "../../../../packages/ui-kit/src/locales/en/profile.json";
import en_tasks from "../../../../packages/ui-kit/src/locales/en/tasks.json";
import en_voice from "../../../../packages/ui-kit/src/locales/en/voice.json";
import zhHans_account from "../../../../packages/ui-kit/src/locales/zh-Hans/account.json";
import zhHans_ambient from "../../../../packages/ui-kit/src/locales/zh-Hans/ambient.json";
import zhHans_auth from "../../../../packages/ui-kit/src/locales/zh-Hans/auth.json";
import zhHans_browser from "../../../../packages/ui-kit/src/locales/zh-Hans/browser.json";
import zhHans_card from "../../../../packages/ui-kit/src/locales/zh-Hans/card.json";
import zhHans_chat from "../../../../packages/ui-kit/src/locales/zh-Hans/chat.json";
import zhHans_common from "../../../../packages/ui-kit/src/locales/zh-Hans/common.json";
import zhHans_connect from "../../../../packages/ui-kit/src/locales/zh-Hans/connect.json";
import zhHans_onboarding from "../../../../packages/ui-kit/src/locales/zh-Hans/onboarding.json";
import zhHans_profile from "../../../../packages/ui-kit/src/locales/zh-Hans/profile.json";
import zhHans_tasks from "../../../../packages/ui-kit/src/locales/zh-Hans/tasks.json";
import zhHans_voice from "../../../../packages/ui-kit/src/locales/zh-Hans/voice.json";
import ja_account from "../../../../packages/ui-kit/src/locales/ja/account.json";
import ja_ambient from "../../../../packages/ui-kit/src/locales/ja/ambient.json";
import ja_auth from "../../../../packages/ui-kit/src/locales/ja/auth.json";
import ja_browser from "../../../../packages/ui-kit/src/locales/ja/browser.json";
import ja_card from "../../../../packages/ui-kit/src/locales/ja/card.json";
import ja_chat from "../../../../packages/ui-kit/src/locales/ja/chat.json";
import ja_common from "../../../../packages/ui-kit/src/locales/ja/common.json";
import ja_connect from "../../../../packages/ui-kit/src/locales/ja/connect.json";
import ja_onboarding from "../../../../packages/ui-kit/src/locales/ja/onboarding.json";
import ja_profile from "../../../../packages/ui-kit/src/locales/ja/profile.json";
import ja_tasks from "../../../../packages/ui-kit/src/locales/ja/tasks.json";
import ja_voice from "../../../../packages/ui-kit/src/locales/ja/voice.json";
import ko_account from "../../../../packages/ui-kit/src/locales/ko/account.json";
import ko_ambient from "../../../../packages/ui-kit/src/locales/ko/ambient.json";
import ko_auth from "../../../../packages/ui-kit/src/locales/ko/auth.json";
import ko_browser from "../../../../packages/ui-kit/src/locales/ko/browser.json";
import ko_card from "../../../../packages/ui-kit/src/locales/ko/card.json";
import ko_chat from "../../../../packages/ui-kit/src/locales/ko/chat.json";
import ko_common from "../../../../packages/ui-kit/src/locales/ko/common.json";
import ko_connect from "../../../../packages/ui-kit/src/locales/ko/connect.json";
import ko_onboarding from "../../../../packages/ui-kit/src/locales/ko/onboarding.json";
import ko_profile from "../../../../packages/ui-kit/src/locales/ko/profile.json";
import ko_tasks from "../../../../packages/ui-kit/src/locales/ko/tasks.json";
import ko_voice from "../../../../packages/ui-kit/src/locales/ko/voice.json";
import es_account from "../../../../packages/ui-kit/src/locales/es/account.json";
import es_ambient from "../../../../packages/ui-kit/src/locales/es/ambient.json";
import es_auth from "../../../../packages/ui-kit/src/locales/es/auth.json";
import es_browser from "../../../../packages/ui-kit/src/locales/es/browser.json";
import es_card from "../../../../packages/ui-kit/src/locales/es/card.json";
import es_chat from "../../../../packages/ui-kit/src/locales/es/chat.json";
import es_common from "../../../../packages/ui-kit/src/locales/es/common.json";
import es_connect from "../../../../packages/ui-kit/src/locales/es/connect.json";
import es_onboarding from "../../../../packages/ui-kit/src/locales/es/onboarding.json";
import es_profile from "../../../../packages/ui-kit/src/locales/es/profile.json";
import es_tasks from "../../../../packages/ui-kit/src/locales/es/tasks.json";
import es_voice from "../../../../packages/ui-kit/src/locales/es/voice.json";
import fr_account from "../../../../packages/ui-kit/src/locales/fr/account.json";
import fr_ambient from "../../../../packages/ui-kit/src/locales/fr/ambient.json";
import fr_auth from "../../../../packages/ui-kit/src/locales/fr/auth.json";
import fr_browser from "../../../../packages/ui-kit/src/locales/fr/browser.json";
import fr_card from "../../../../packages/ui-kit/src/locales/fr/card.json";
import fr_chat from "../../../../packages/ui-kit/src/locales/fr/chat.json";
import fr_common from "../../../../packages/ui-kit/src/locales/fr/common.json";
import fr_connect from "../../../../packages/ui-kit/src/locales/fr/connect.json";
import fr_onboarding from "../../../../packages/ui-kit/src/locales/fr/onboarding.json";
import fr_profile from "../../../../packages/ui-kit/src/locales/fr/profile.json";
import fr_tasks from "../../../../packages/ui-kit/src/locales/fr/tasks.json";
import fr_voice from "../../../../packages/ui-kit/src/locales/fr/voice.json";
import de_account from "../../../../packages/ui-kit/src/locales/de/account.json";
import de_ambient from "../../../../packages/ui-kit/src/locales/de/ambient.json";
import de_auth from "../../../../packages/ui-kit/src/locales/de/auth.json";
import de_browser from "../../../../packages/ui-kit/src/locales/de/browser.json";
import de_card from "../../../../packages/ui-kit/src/locales/de/card.json";
import de_chat from "../../../../packages/ui-kit/src/locales/de/chat.json";
import de_common from "../../../../packages/ui-kit/src/locales/de/common.json";
import de_connect from "../../../../packages/ui-kit/src/locales/de/connect.json";
import de_onboarding from "../../../../packages/ui-kit/src/locales/de/onboarding.json";
import de_profile from "../../../../packages/ui-kit/src/locales/de/profile.json";
import de_tasks from "../../../../packages/ui-kit/src/locales/de/tasks.json";
import de_voice from "../../../../packages/ui-kit/src/locales/de/voice.json";
import pt_account from "../../../../packages/ui-kit/src/locales/pt/account.json";
import pt_ambient from "../../../../packages/ui-kit/src/locales/pt/ambient.json";
import pt_auth from "../../../../packages/ui-kit/src/locales/pt/auth.json";
import pt_browser from "../../../../packages/ui-kit/src/locales/pt/browser.json";
import pt_card from "../../../../packages/ui-kit/src/locales/pt/card.json";
import pt_chat from "../../../../packages/ui-kit/src/locales/pt/chat.json";
import pt_common from "../../../../packages/ui-kit/src/locales/pt/common.json";
import pt_connect from "../../../../packages/ui-kit/src/locales/pt/connect.json";
import pt_onboarding from "../../../../packages/ui-kit/src/locales/pt/onboarding.json";
import pt_profile from "../../../../packages/ui-kit/src/locales/pt/profile.json";
import pt_tasks from "../../../../packages/ui-kit/src/locales/pt/tasks.json";
import pt_voice from "../../../../packages/ui-kit/src/locales/pt/voice.json";

// en 全量 = 类型真源（i18next.d.ts 用 typeof EN_RESOURCES 给 t() 上 key 类型检查）。
export const EN_RESOURCES = {
  account: en_account,
  ambient: en_ambient,
  auth: en_auth,
  browser: en_browser,
  card: en_card,
  chat: en_chat,
  common: en_common,
  connect: en_connect,
  onboarding: en_onboarding,
  profile: en_profile,
  tasks: en_tasks,
  voice: en_voice,
} as const;

const RESOURCES = {
  "zh-Hans": { account: zhHans_account, ambient: zhHans_ambient, auth: zhHans_auth, browser: zhHans_browser, card: zhHans_card, chat: zhHans_chat, common: zhHans_common, connect: zhHans_connect, onboarding: zhHans_onboarding, profile: zhHans_profile, tasks: zhHans_tasks, voice: zhHans_voice },
  ja: { account: ja_account, ambient: ja_ambient, auth: ja_auth, browser: ja_browser, card: ja_card, chat: ja_chat, common: ja_common, connect: ja_connect, onboarding: ja_onboarding, profile: ja_profile, tasks: ja_tasks, voice: ja_voice },
  ko: { account: ko_account, ambient: ko_ambient, auth: ko_auth, browser: ko_browser, card: ko_card, chat: ko_chat, common: ko_common, connect: ko_connect, onboarding: ko_onboarding, profile: ko_profile, tasks: ko_tasks, voice: ko_voice },
  es: { account: es_account, ambient: es_ambient, auth: es_auth, browser: es_browser, card: es_card, chat: es_chat, common: es_common, connect: es_connect, onboarding: es_onboarding, profile: es_profile, tasks: es_tasks, voice: es_voice },
  fr: { account: fr_account, ambient: fr_ambient, auth: fr_auth, browser: fr_browser, card: fr_card, chat: fr_chat, common: fr_common, connect: fr_connect, onboarding: fr_onboarding, profile: fr_profile, tasks: fr_tasks, voice: fr_voice },
  de: { account: de_account, ambient: de_ambient, auth: de_auth, browser: de_browser, card: de_card, chat: de_chat, common: de_common, connect: de_connect, onboarding: de_onboarding, profile: de_profile, tasks: de_tasks, voice: de_voice },
  pt: { account: pt_account, ambient: pt_ambient, auth: pt_auth, browser: pt_browser, card: pt_card, chat: pt_chat, common: pt_common, connect: pt_connect, onboarding: pt_onboarding, profile: pt_profile, tasks: pt_tasks, voice: pt_voice },
  en: EN_RESOURCES,
};

/** 首启/未登录 UI 语言：跟 iOS 设备语言（web 版用 navigator，介质各异）。
 *  导出给 onboarding 完成时写正式 generationLanguage（= dev App.tsx 的
 *  detectDeviceLanguage 同位调用）。 */
export function detectDeviceLanguage(): SupportedGenerationLanguage {
  const settingsManager = (NativeModules as {
    SettingsManager?: { settings?: { AppleLanguages?: string[]; AppleLocale?: string } };
  }).SettingsManager;
  const tag =
    settingsManager?.settings?.AppleLanguages?.[0] ??
    settingsManager?.settings?.AppleLocale ??
    "";
  return matchSupportedLanguage(tag);
}

void i18n.use(initReactI18next).init({
  lng: detectDeviceLanguage(),
  fallbackLng: "en",
  defaultNS: "common",
  ns: Object.keys(EN_RESOURCES),
  resources: RESOURCES,
  interpolation: { escapeValue: false }, // React 自身已做 XSS 转义
  react: { useSuspense: false },
  returnNull: false,
});

/**
 * 切换 UI 语言。签名对齐 web 的 loadAndSwitchLanguage；RN 全部语料已静态打包，
 * 无需懒加载，直接 changeLanguage。
 */
export async function loadAndSwitchLanguage(
  lang: SupportedGenerationLanguage,
): Promise<void> {
  await i18n.changeLanguage(lang);
}

export default i18n;
