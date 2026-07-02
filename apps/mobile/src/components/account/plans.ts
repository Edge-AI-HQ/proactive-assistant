/**
 * 计划目录 —— web `ui-web/account/PlanPaymentForm.tsx` 的 PLANS 逻辑数据 +
 * `locales/<lang>/account.json` 的 `plans.<id>.*` 展示文案（name/credits/perks
 * 走 i18n，8 语言全在，对齐 dev PlanPaymentForm 的 planName/planCredits/planPerks）。
 * Credits 数字对应 pai_billing_plans.monthly_refresh_credits
 * （100 credits = $1 USD LiteLLM budget，migration 058：$39→3900 / $99→9900 / $199→19900）。
 * web Plan 的 icon 字段只被 PlanPaymentForm（PaywallDrawer 用）消费，
 * SubscriptionPanel 不用 → 此处不带。
 */
import i18n from "../../i18n";

export type PlanId = "basic" | "pro" | "max";

interface Plan {
  id: PlanId;
  price: number;
  localModel: string;
  cloudModel: string;
  highlight?: boolean;
}

export const PLANS: Plan[] = [
  { id: "basic", price: 39, localModel: "Gemma 2B", cloudModel: "Gemini Flash" },
  { id: "pro", price: 99, localModel: "Llama 3 8B", cloudModel: "Claude Sonnet", highlight: true },
  { id: "max", price: 199, localModel: "Llama 3 70B", cloudModel: "Claude Opus / GPT-5" },
];

export function planName(id: PlanId): string {
  return i18n.t(`account:plans.${id}.name`);
}

export function planCredits(id: PlanId): string {
  return i18n.t(`account:plans.${id}.credits`);
}

export function planPerks(id: PlanId): string[] {
  return i18n.t(`account:plans.${id}.perks`, { returnObjects: true }) as string[]; // returnObjects 返回 i18next $SpecialObject,数组形态需断言
}
