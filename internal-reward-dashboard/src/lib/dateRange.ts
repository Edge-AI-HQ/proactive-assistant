function localDateIso(value: string, hour: number, minute: number, second: number, millisecond: number): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(year, month - 1, day, hour, minute, second, millisecond);
  if (
    !Number.isFinite(date.getTime())
    || date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
  ) {
    return undefined;
  }
  return date.toISOString();
}

export function dayStartIso(value: string): string | undefined {
  return value ? localDateIso(value, 0, 0, 0, 0) : undefined;
}

export function dayEndIso(value: string): string | undefined {
  return value ? localDateIso(value, 23, 59, 59, 999) : undefined;
}

export function dateRangeOrderError(since: string, until: string, label: string): string | null {
  const start = dayStartIso(since);
  const end = dayEndIso(until);
  if (start && end && new Date(start).getTime() > new Date(end).getTime()) {
    return `${label}开始日期不能晚于结束日期。`;
  }
  return null;
}
