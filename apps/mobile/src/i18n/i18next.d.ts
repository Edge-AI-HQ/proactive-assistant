import "i18next";

import type { EN_RESOURCES } from "./index";

// 对齐 ui-web/src/i18n/i18next.d.ts：t() 的 key 由 en 语料类型化——
// 写错 key 直接 tsc 报错（Phase 3 全屏接线的质量闸门）。
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: typeof EN_RESOURCES;
    returnNull: false;
  }
}
