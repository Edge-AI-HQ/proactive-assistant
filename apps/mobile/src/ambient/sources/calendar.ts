/**
 * Calendar 源（RN 直替：expo-calendar 覆盖 EventKit 读取）。周期扫描未来
 * 24h 的设备日历事件；dedupe_key 防重（与 web sources/calendar.ts 同语义，
 * schema_version calendar_event.v1）。
 */
import * as Calendar from "expo-calendar";

import { SIGNAL_KINDS, type AmbientSource, type SourceContext } from "../types";

const SCAN_INTERVAL_MS = 15 * 60 * 1000;
const LOOKAHEAD_MS = 24 * 60 * 60 * 1000;

export function createCalendarSource(ctx: SourceContext): AmbientSource {
  let timer: ReturnType<typeof setInterval> | null = null;

  async function scan() {
    // SDK 56 的 expo-calendar 是 Next API（getCalendars/listEvents，无
    // Async 后缀；旧 *Async 名运行时 throw——真机实测踩到）。
    const calendars = await Calendar.getCalendars(Calendar.EntityTypes.EVENT);
    const start = new Date();
    const end = new Date(Date.now() + LOOKAHEAD_MS);
    const events = await Calendar.listEvents(calendars, start, end);
    let pushed = 0;
    for (const event of events) {
      if (!event.startDate) continue;
      const startsAt = new Date(event.startDate).toISOString();
      const endsAt = event.endDate ? new Date(event.endDate).toISOString() : undefined;
      ctx.push({
        kind: SIGNAL_KINDS.calendarEvent,
        title: "Calendar event",
        summary: `${event.title ?? "Untitled"} · ${new Date(event.startDate).toLocaleString()}`,
        occurred_at: startsAt,
        dedupe_key: `cal:${event.id}:${startsAt}`,
        payload: {
          schema_version: "calendar_event.v1",
          title: event.title,
          starts_at: startsAt,
          ends_at: endsAt,
          all_day: event.allDay,
          location: event.location || undefined,
        },
      });
      pushed += 1;
    }
    if (pushed > 0) ctx.onEvent("calendar", `${pushed} upcoming events`);
  }

  return {
    key: "calendar",
    label: "Calendar",
    isStarted: () => timer !== null,
    async start() {
      if (timer) return;
      const { status } = await Calendar.requestCalendarPermissions();
      if (status !== "granted") throw new Error("calendar permission denied");
      await scan();
      timer = setInterval(() => void scan(), SCAN_INTERVAL_MS);
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    refresh: scan,
  };
}
