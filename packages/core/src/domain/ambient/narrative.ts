import type { AmbientTimelineEvent } from "./types";

export type AmbientTimelineGroupLabel = "Morning" | "Midday" | "Afternoon" | "Evening";

export interface AmbientTimelineGroup {
  label: AmbientTimelineGroupLabel;
  events: AmbientTimelineEvent[];
}

export function buildAmbientNarrativeSummary(events: AmbientTimelineEvent[]): string | null {
  const visible = orderedVisibleEvents(events);
  if (visible.length < 2) return null;
  const keyEvents = visible.slice(0, 5);
  const first = keyEvents[0];
  if (!first) return null;
  const moments = keyEvents
    .slice(0, 3)
    .map((event) => `${event.title} — ${event.summary.trim()}`)
    .join("; ");
  return `Your local timeline has ${visible.length} events today, starting with ${first.title}. Key moments: ${moments}`;
}

export function groupAmbientTimelineEvents(events: AmbientTimelineEvent[]): AmbientTimelineGroup[] {
  const visible = orderedVisibleEvents(events);
  if (visible.length < 5) return [];
  const byLabel = new Map<AmbientTimelineGroupLabel, AmbientTimelineEvent[]>();
  for (const event of visible) {
    const label = labelForHour(Number(event.occurredAt.slice(11, 13)));
    byLabel.set(label, [...(byLabel.get(label) ?? []), event]);
  }
  return (["Morning", "Midday", "Afternoon", "Evening"] as AmbientTimelineGroupLabel[])
    .flatMap((label) => {
      const groupEvents = byLabel.get(label) ?? [];
      return groupEvents.length > 0 ? [{ label, events: groupEvents }] : [];
    });
}

function orderedVisibleEvents(events: AmbientTimelineEvent[]): AmbientTimelineEvent[] {
  return events
    .filter((event) => event.generationStatus === "visible")
    .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
}

function labelForHour(hour: number): AmbientTimelineGroupLabel {
  if (hour >= 5 && hour < 12) return "Morning";
  if (hour >= 12 && hour < 14) return "Midday";
  if (hour >= 14 && hour < 18) return "Afternoon";
  return "Evening";
}

