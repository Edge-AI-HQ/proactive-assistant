import "i18next";

import type { EN_RESOURCES } from "./index";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: typeof EN_RESOURCES;
    returnNull: false;
  }
}
