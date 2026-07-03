import { describe, expect, test } from "vitest";

import { buildCardContext } from "./card-context";

describe("buildCardContext", () => {
  test("projects the full card_context payload (ui-web buildCardContext parity)", () => {
    expect(
      buildCardContext({
        title: "Prep Monday standup",
        category: "work",
        tag: "Urgent",
        cardKind: "reminder",
        scheduleTaskId: "task-42",
        line1: "Standup is in 2 hours",
        whyNow: "Calendar shows the meeting at 10am",
        sourceApps: ["gcal"],
        detail: { willExecute: "Draft the agenda", executionPlan: [] },
      }),
    ).toEqual({
      title: "Prep Monday standup",
      category: "work",
      tag: "Urgent",
      cardKind: "reminder",
      scheduleTaskId: "task-42",
      summary: "Standup is in 2 hours",
      whyNow: "Calendar shows the meeting at 10am",
      sources: ["gcal"],
      primaryAction: { label: "Draft the agenda", type: "confirm" },
      detail: { willExecute: "Draft the agenda", executionPlan: [] },
    });
  });

  test("omits optional fields and falls back like the ui-web original", () => {
    const ctx = buildCardContext({
      title: "Read later",
      category: "life",
      line1: "Saved article",
    });
    // whyNow falls back to line1; sources default to []; no willExecute → no primaryAction.
    expect(ctx).toEqual({
      title: "Read later",
      category: "life",
      tag: undefined,
      summary: "Saved article",
      whyNow: "Saved article",
      sources: [],
      primaryAction: undefined,
      detail: undefined,
    });
    // cardKind / scheduleTaskId are spread-omitted, not set to undefined.
    expect("cardKind" in ctx).toBe(false);
    expect("scheduleTaskId" in ctx).toBe(false);
  });
});
