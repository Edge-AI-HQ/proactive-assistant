/**
 * 时间格式 helper——web `packages/ui-web/src/lib/format.ts` 的 RN 适配版。
 *
 * ⚠️ 不能照抄 web 的 `Intl.RelativeTimeFormat`：RN 的 JS 引擎是 **Hermes**，
 * 它的 Intl 只实现了 DateTimeFormat / NumberFormat / Collator 等子集，
 * `Intl.RelativeTimeFormat` 是 undefined（构造即崩 "undefined cannot be used
 * as a constructor"，2026-07-01 真机踩过）。dev 跑在 WKWebView（WebKit 完整
 * Intl）所以 web 源没问题。这里手写 en 输出，对齐 Intl en + numeric:"auto"
 * 的措辞（"5 minutes ago" / "yesterday" / "last week" / "now"）。
 *
 * formatDate / formatTime / formatDateTime 用 Intl.DateTimeFormat（Hermes 有）
 * 照抄 web 版，locale 钉 "en"（RN 无 i18n，产品 UI 一律英文）。
 */

type DateInput = Date | string | number;

const toDate = (d: DateInput): Date => (d instanceof Date ? d : new Date(d));

/** 日期（"Jun 12, 2026"）。 */
export function formatDate(
  d: DateInput,
  opts: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric" },
): string {
  return new Intl.DateTimeFormat("en", opts).format(toDate(d));
}

/** 时分（en 12h："6:00 AM"）。 */
export function formatTime(
  d: DateInput,
  opts: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" },
): string {
  return new Intl.DateTimeFormat("en", opts).format(toDate(d));
}

/** 日期 + 时分。 */
export function formatDateTime(d: DateInput): string {
  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(toDate(d));
}

const RELATIVE_STEPS: {
  unit: string;
  seconds: number;
  /** numeric:"auto" 在 ±1 的特殊词（en CLDR）；无则走 "N units ago" 通式。 */
  pastOne?: string;
  futureOne?: string;
}[] = [
  { unit: "year", seconds: 31_536_000, pastOne: "last year", futureOne: "next year" },
  { unit: "month", seconds: 2_592_000, pastOne: "last month", futureOne: "next month" },
  { unit: "week", seconds: 604_800, pastOne: "last week", futureOne: "next week" },
  { unit: "day", seconds: 86_400, pastOne: "yesterday", futureOne: "tomorrow" },
  { unit: "hour", seconds: 3_600 },
  { unit: "minute", seconds: 60 },
  { unit: "second", seconds: 1 },
];

/** "5 minutes ago" 风格相对时间（web formatRelativeTime 的 en 输出同构）。 */
export function formatRelativeTime(d: Date | string | number, now: Date = new Date()): string {
  const date = d instanceof Date ? d : new Date(d);
  const diffSeconds = (date.getTime() - now.getTime()) / 1000;
  const abs = Math.abs(diffSeconds);
  for (const step of RELATIVE_STEPS) {
    if (abs >= step.seconds || step.unit === "second") {
      const n = Math.round(diffSeconds / step.seconds);
      const m = Math.abs(n);
      if (n === 0) return "now"; // Intl auto：second 0 → "now"
      if (m === 1 && step.pastOne && step.futureOne) {
        return n < 0 ? step.pastOne : step.futureOne;
      }
      const unitLabel = m === 1 ? step.unit : `${step.unit}s`;
      return n < 0 ? `${m} ${unitLabel} ago` : `in ${m} ${unitLabel}`;
    }
  }
  return "now";
}
