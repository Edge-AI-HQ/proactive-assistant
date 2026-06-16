import i18n from "../i18n";

type DateInput = Date | string | number;

const toDate = (d: DateInput): Date => (d instanceof Date ? d : new Date(d));
const locale = (): string => i18n.language || "en";

/** 日期(默认 "Jun 12, 2026" / "2026年6月12日"),跟随当前 UI 语言。 */
export function formatDate(
  d: DateInput,
  opts: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric" },
): string {
  return new Intl.DateTimeFormat(locale(), opts).format(toDate(d));
}

/** 时分(钟制跟语言习惯:en 12h / zh-de 24h)。 */
export function formatTime(
  d: DateInput,
  opts: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" },
): string {
  return new Intl.DateTimeFormat(locale(), opts).format(toDate(d));
}

/** 日期 + 时分。 */
export function formatDateTime(d: DateInput): string {
  return new Intl.DateTimeFormat(locale(), {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(toDate(d));
}

const RELATIVE_STEPS: { unit: Intl.RelativeTimeFormatUnit; seconds: number }[] = [
  { unit: "year", seconds: 31_536_000 },
  { unit: "month", seconds: 2_592_000 },
  { unit: "week", seconds: 604_800 },
  { unit: "day", seconds: 86_400 },
  { unit: "hour", seconds: 3_600 },
  { unit: "minute", seconds: 60 },
  { unit: "second", seconds: 1 },
];

/** "5 minutes ago" / "5分钟前" 风格相对时间(替换各处手写 "5m ago")。 */
export function formatRelativeTime(d: DateInput, now: Date = new Date()): string {
  const diffSeconds = (toDate(d).getTime() - now.getTime()) / 1000;
  const abs = Math.abs(diffSeconds);
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: "auto" });
  for (const { unit, seconds } of RELATIVE_STEPS) {
    if (abs >= seconds || unit === "second") {
      return rtf.format(Math.round(diffSeconds / seconds), unit);
    }
  }
  return rtf.format(0, "second");
}
