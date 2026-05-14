export function formatDateTimeOrDash(
  value: string | null | undefined,
  options: Intl.DateTimeFormatOptions,
  locale?: string,
): string {
  if (!value) return "-";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "-";
  return new Intl.DateTimeFormat(locale, options).format(date);
}
