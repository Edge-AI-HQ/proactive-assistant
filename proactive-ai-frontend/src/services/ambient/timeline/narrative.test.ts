import { describe, expect, test } from "vitest";

import { buildAmbientNarrativeSummary, groupAmbientTimelineEvents } from "./narrative";
import type { AmbientTimelineEvent } from "./types";

function event(id: string, occurredAt: string, title: string, summary: string): AmbientTimelineEvent {
  return {
    id,
    localUserId: "local",
    localDate: "2026-05-15",
    timezone: "UTC",
    occurredAt,
    eventType: "visit",
    title,
    summary,
    primarySourceLabel: "iPhone",
    deviceLabels: ["iPhone"],
    sourceTypes: ["visit"],
    tags: ["visit"],
    privacy: "private",
    confidence: 0.7,
    confidenceLabel: "certain",
    salience: 0.5,
    rawRefs: [],
    observationIds: [],
    generationMethod: "rule",
    generationStatus: "visible",
    memoryCandidate: false,
    cardTriggerCandidate: false,
    schemaVersion: "ambient_timeline_event.v1",
    syncStatus: "pending",
    dedupeKey: id,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
}

describe("ambient timeline narrative", () => {
  test("does not summarize fewer than two real events", () => {
    expect(buildAmbientNarrativeSummary([event("1", "2026-05-15T09:00:00.000Z", "Arrived", "Arrived near office.")])).toBeNull();
  });

  test("builds a deterministic summary from visible timeline event text", () => {
    const summary = buildAmbientNarrativeSummary([
      event("2", "2026-05-15T12:00:00.000Z", "Lunch", "Arrived near lunch spot."),
      event("1", "2026-05-15T09:00:00.000Z", "Office", "Arrived near office."),
    ]);

    expect(summary).toBe("Your local timeline has 2 events today, starting with Office. Key moments: Office — Arrived near office.; Lunch — Arrived near lunch spot.");
  });

  test("only groups timeline events after there are at least five entries", () => {
    expect(groupAmbientTimelineEvents([
      event("1", "2026-05-15T09:00:00.000Z", "Office", "Arrived near office."),
    ])).toEqual([]);

    const groups = groupAmbientTimelineEvents([
      event("1", "2026-05-15T09:00:00.000Z", "Morning", "Morning event."),
      event("2", "2026-05-15T12:30:00.000Z", "Midday", "Midday event."),
      event("3", "2026-05-15T15:00:00.000Z", "Afternoon", "Afternoon event."),
      event("4", "2026-05-15T19:00:00.000Z", "Evening", "Evening event."),
      event("5", "2026-05-15T20:00:00.000Z", "Later", "Later event."),
    ]);

    expect(groups.map((group) => [group.label, group.events.map((item) => item.id)])).toEqual([
      ["Morning", ["1"]],
      ["Midday", ["2"]],
      ["Afternoon", ["3"]],
      ["Evening", ["4", "5"]],
    ]);
  });
});
