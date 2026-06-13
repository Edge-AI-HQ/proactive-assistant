export type DeviceTimelineDayFilter = "all" | "today" | "yesterday" | "last7d" | "custom";

export const DEVICE_TIMELINE_QUICK_FILTERS = [
  { value: "all", label: "All" },
  { value: "today", label: "Today" },
] as const satisfies Array<{ value: DeviceTimelineDayFilter; label: string }>;

export interface DeviceTimelineDateRange {
  since?: string;
  until?: string;
  label: string;
}

export function formatLocalDateInput(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

export function getDeviceTimelineDateRange(
  filter: DeviceTimelineDayFilter,
  customDay: string,
  now: Date = new Date(),
): DeviceTimelineDateRange {
  if (filter === "all") {
    return { label: "All days" };
  }

  if (filter === "today") {
    return rangeForLocalDay(startOfLocalDay(now), "Today");
  }

  if (filter === "yesterday") {
    const day = startOfLocalDay(now);
    day.setDate(day.getDate() - 1);
    return rangeForLocalDay(day, "Yesterday");
  }

  if (filter === "last7d") {
    const start = startOfLocalDay(now);
    start.setDate(start.getDate() - 6);
    const end = endOfLocalDay(now);
    return {
      since: start.toISOString(),
      until: end.toISOString(),
      label: "Last 7 days",
    };
  }

  const parsed = parseLocalDateInput(customDay);
  if (!parsed) return { label: "Custom day" };
  return rangeForLocalDay(parsed, formatLocalDateInput(parsed));
}

function parseLocalDateInput(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);

  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
  ) {
    return null;
  }

  return date;
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function endOfLocalDay(date: Date): Date {
  const end = startOfLocalDay(date);
  end.setDate(end.getDate() + 1);
  end.setMilliseconds(end.getMilliseconds() - 1);
  return end;
}

function rangeForLocalDay(day: Date, label: string): DeviceTimelineDateRange {
  return {
    since: startOfLocalDay(day).toISOString(),
    until: endOfLocalDay(day).toISOString(),
    label,
  };
}
