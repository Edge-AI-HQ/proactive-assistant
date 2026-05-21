import { AmbientAi, type CalendarEventEvent } from "@pin/capacitor-ambient-ai";
import type { PluginListenerHandle } from "@capacitor/core";
import { SIGNAL_KINDS } from "../kinds";
import type { AmbientSource, SourceContext } from "./types";

export class CalendarSource implements AmbientSource {
  readonly key = "calendar";
  readonly label = "Calendar";

  private listenerHandle: PluginListenerHandle | null = null;
  private started = false;

  constructor(private ctx: SourceContext) {}

  isStarted(): boolean {
    return this.started;
  }

  async start(): Promise<void> {
    if (this.started) return;
    const perm = await AmbientAi.calendar.requestPermissions();
    if (perm.calendar !== "granted") {
      throw new Error(`calendar permission ${perm.calendar}`);
    }
    this.listenerHandle = await AmbientAi.addListener("calendarEvent", (event) => this.handle(event));
    await AmbientAi.calendar.startMonitoring();
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    try {
      await AmbientAi.calendar.stopMonitoring();
    } finally {
      if (this.listenerHandle) {
        await this.listenerHandle.remove();
        this.listenerHandle = null;
      }
      this.started = false;
    }
  }

  private handle(event: CalendarEventEvent): void {
    const startsAt = new Date(event.startsAt).toISOString();
    const endsAt = new Date(event.endsAt).toISOString();
    const title = event.title || "(untitled)";
    const summary = `${title} ${formatTime(startsAt)}-${formatTime(endsAt)}`;
    this.ctx.push({
      kind: SIGNAL_KINDS.calendarEvent,
      title: "Calendar event",
      summary,
      occurred_at: startsAt,
      available_at: new Date(event.timestamp).toISOString(),
      payload: {
        schema_version: "calendar_event.v1",
        title: event.title,
        starts_at: startsAt,
        ends_at: endsAt,
        attendee_count: event.attendeeCount,
        calendar: event.calendar,
        observed_at: new Date(event.timestamp).toISOString(),
      },
      dedupe_key: `calendar:${event.calendar}:${event.title}:${startsAt}:${endsAt}`,
    });
    this.ctx.onEvent(this.key, summary);
  }
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
