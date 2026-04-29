export interface DreamingSchedule { type: 'daily'; hour: 6; minute: 0; timezone: string; }

export interface DreamingDueInput {
  now?: Date;
  timezone: string;
  lastAutoCompletedAt: string | null;
}

function formatLocalParts(date: Date, timezone: string): Record<string, string> {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return formatter.formatToParts(date).reduce<Record<string, string>>((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
}

export function toDreamingLocalDayKey(date: Date, timezone: string): string {
  const parts = formatLocalParts(date, timezone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function getDreamingSchedule(timezone: string): DreamingSchedule {
  return { type: 'daily', hour: 6, minute: 0, timezone };
}

export function resolveDreamingTimezone(
  profileTimezone: string | null | undefined,
  systemTimezone: string,
): string {
  return profileTimezone && profileTimezone.trim().length > 0
    ? profileTimezone
    : systemTimezone;
}

export function isDreamingDue(input: DreamingDueInput): boolean {
  const now = input.now ?? new Date();
  const parts = formatLocalParts(now, input.timezone);
  const currentHour = Number(parts.hour ?? '0');
  const currentMinute = Number(parts.minute ?? '0');
  const afterSix = currentHour > 6 || (currentHour === 6 && currentMinute >= 0);
  if (!afterSix) return false;
  if (!input.lastAutoCompletedAt) return true;
  const lastAutoDate = new Date(input.lastAutoCompletedAt);
  return toDreamingLocalDayKey(lastAutoDate, input.timezone) !== toDreamingLocalDayKey(now, input.timezone);
}
