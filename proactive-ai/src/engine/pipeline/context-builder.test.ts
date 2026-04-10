import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./data-access.js", () => ({
  getDefaultProfile: vi.fn(),
  getDefaultProfileFacts: vi.fn(),
  getDefaultProfileGoals: vi.fn(),
  getDefaultProfilePreferences: vi.fn(),
  getDefaultProfileConstraints: vi.fn(),
  getDefaultProfileSnapshot: vi.fn(),
  listPersonalConnections: vi.fn(),
  getPersonalStatus: vi.fn(),
  listPushHistorySummary: vi.fn(),
  listFeedbackSummary: vi.fn(),
  shortlistWorldItemsForDefaultProfile: vi.fn(),
}));

import {
  buildContextBrief,
  parseIncrementalContext,
} from "./context-builder.js";
import {
  getDefaultProfile,
  getDefaultProfileFacts,
  getDefaultProfileGoals,
  getDefaultProfilePreferences,
  getDefaultProfileConstraints,
  getDefaultProfileSnapshot,
  listPersonalConnections,
  getPersonalStatus,
  listPushHistorySummary,
  listFeedbackSummary,
  shortlistWorldItemsForDefaultProfile,
} from "./data-access.js";

describe("buildContextBrief", () => {
  beforeEach(() => {
    vi.mocked(getDefaultProfile).mockResolvedValue(null);
    vi.mocked(getDefaultProfileFacts).mockResolvedValue({});
    vi.mocked(getDefaultProfileGoals).mockResolvedValue([]);
    vi.mocked(getDefaultProfilePreferences).mockResolvedValue({});
    vi.mocked(getDefaultProfileConstraints).mockResolvedValue({});
    vi.mocked(getDefaultProfileSnapshot).mockResolvedValue(null);
    vi.mocked(listPersonalConnections).mockResolvedValue([]);
    vi.mocked(getPersonalStatus).mockResolvedValue({ configured: false, mode: "none" });
    vi.mocked(listPushHistorySummary).mockResolvedValue([]);
    vi.mocked(listFeedbackSummary).mockResolvedValue([]);
    vi.mocked(shortlistWorldItemsForDefaultProfile).mockResolvedValue([]);
  });

  it("builds a cold-start brief and records per-source trace events", async () => {
    const traceEvents: Array<{ kind: string; name: string }> = [];

    const brief = await buildContextBrief({
      incrementalContext: JSON.stringify({
        runToken: "loop_1",
        generatedAt: "2026-04-09T10:00:00.000Z",
        items: {
          world: [{ id: "w1", title: "Fed holds rates" }],
          personal: [],
        },
        meta: {
          pendingCount: 1,
          oldestPendingAt: "2026-04-09T09:00:00.000Z",
        },
      }),
      onTrace(event) {
        traceEvents.push({ kind: event.kind, name: event.name });
      },
    });

    expect(brief.profileStatus.exists).toBe(false);
    expect(brief.worldStatus.shortlistCount).toBe(0);
    expect(brief.recentSignals.incremental.world).toHaveLength(1);
    expect(brief.knownGaps).toEqual(expect.arrayContaining([
      "profile.missing",
      "personal.unconfigured",
    ]));
    expect(traceEvents).toEqual(expect.arrayContaining([
      { kind: "context.source.start", name: "profile" },
      { kind: "context.source.finish", name: "profile" },
      { kind: "context.source.start", name: "world" },
      { kind: "context.source.finish", name: "world" },
    ]));
  });

  it("captures profile, personal, and world availability in the brief", async () => {
    vi.mocked(getDefaultProfile).mockResolvedValue({
      id: "default",
      displayName: "Song",
      summary: "Founder",
    });
    vi.mocked(getDefaultProfileFacts).mockResolvedValue({ city: "Shanghai" });
    vi.mocked(getDefaultProfileGoals).mockResolvedValue([
      { key: "work-q2", title: "Ship the benchmark" },
    ]);
    vi.mocked(getDefaultProfilePreferences).mockResolvedValue({ briefingStyle: "concise" });
    vi.mocked(getDefaultProfileConstraints).mockResolvedValue({ quiet_hours: "23:00-08:00" });
    vi.mocked(getDefaultProfileSnapshot).mockResolvedValue({
      topPositiveTopics: [{ key: "ai", score: 0.9 }],
      activeConstraints: [{ key: "quiet_hours" }],
    });
    vi.mocked(getPersonalStatus).mockResolvedValue({ configured: true, mode: "platform" });
    vi.mocked(listPersonalConnections).mockResolvedValue([
      { id: "gmail", toolkit: "gmail", status: "connected" },
    ]);
    vi.mocked(shortlistWorldItemsForDefaultProfile).mockResolvedValue([
      { id: "world-1", title: "AI regulation update", profileScore: 0.88 },
    ]);

    const brief = await buildContextBrief({});

    expect(brief.profileStatus.exists).toBe(true);
    expect(brief.profileStatus.goalsCount).toBe(1);
    expect(brief.personalStatus.connectedCount).toBe(1);
    expect(brief.worldStatus.shortlistCount).toBe(1);
    expect(brief.candidateWorldItems[0]).toMatchObject({ id: "world-1" });
    expect(brief.dedupContext.profile?.goals).toEqual(expect.any(Array));
  });
});

describe("parseIncrementalContext", () => {
  it("returns null when the payload is invalid", () => {
    expect(parseIncrementalContext("not-json")).toBeNull();
  });
});
