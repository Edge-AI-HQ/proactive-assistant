import { describe, expect, it } from "vitest";

import { buildIntentEvidencePacks } from "./evidence-builder.js";

describe("buildIntentEvidencePacks", () => {
  it("builds per-intent evidence packs from the shared context brief", async () => {
    const packs = await buildIntentEvidencePacks({
      contextBrief: {
        profileStatus: { exists: true, displayName: "Song", goalsCount: 1, factsCount: 1, preferenceCount: 1, constraintCount: 1, snapshotAvailable: true },
        personalStatus: { configured: true, mode: "platform", connectedCount: 1, connectedApps: ["gmail"] },
        worldStatus: { shortlistCount: 1, incrementalWorldCount: 1, available: true },
        recentSignals: {
          pushes: [{ id: "push-1", title: "Yesterday card" }],
          feedback: [{ id: "fb-1", kind: "thumbs_up" }],
          incremental: {
            world: [{ id: "world-inc-1", title: "Fed holds rates" }],
            personal: [{ id: "personal-inc-1", title: "Board review tomorrow" }],
          },
          runToken: "loop_1",
          generatedAt: "2026-04-09T10:00:00.000Z",
          pendingCount: 2,
          oldestPendingAt: null,
        },
        knownGaps: [],
        candidateWorldItems: [{ id: "world-1", title: "AI regulation update" }],
        dedupContext: {
          profile: {
            profile: { id: "default", displayName: "Song" },
            facts: { city: "Shanghai" },
            goals: [{ key: "work-q2", title: "Ship pipeline perf improvements" }],
            preferences: { briefingStyle: "concise" },
            constraints: { quiet_hours: "23:00-08:00" },
            snapshot: { topPositiveTopics: [{ key: "ai" }] },
          },
          personal: {
            status: { configured: true, mode: "platform" },
            connections: [{ id: "gmail", toolkit: "gmail", status: "connected" }],
          },
          world: {
            shortlist: [{ id: "world-1", title: "AI regulation update" }],
          },
          recentSignals: {
            pushes: [{ id: "push-1", title: "Yesterday card" }],
            feedback: [{ id: "fb-1", kind: "thumbs_up" }],
            incremental: {
              world: [{ id: "world-inc-1", title: "Fed holds rates" }],
              personal: [{ id: "personal-inc-1", title: "Board review tomorrow" }],
            },
          },
        },
      },
      plan: {
        reasoning: "Focus on timely work planning",
        intentsToGenerate: [
          {
            goalBasket: "work",
            objective: "Prepare for tomorrow's board review",
            whyNow: "The review is tomorrow morning",
            expectedAction: "Draft the briefing",
            evidenceRefs: ["profile.goals", "incremental.personal", "recent.push"],
          },
        ],
      },
    });

    expect(packs).toHaveLength(1);
    expect(packs[0]?.objective).toBe("Prepare for tomorrow's board review");
    expect(packs[0]?.evidenceRefs).toEqual([
      "profile.goals",
      "incremental.personal",
      "recent.push",
    ]);
    expect(packs[0]?.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ ref: "profile.goals" }),
      expect.objectContaining({ ref: "incremental.personal" }),
      expect.objectContaining({ ref: "recent.push" }),
    ]));
  });

  it("deduplicates repeated evidence refs inside each pack", async () => {
    const packs = await buildIntentEvidencePacks({
      contextBrief: {
        profileStatus: { exists: false, displayName: null, goalsCount: 0, factsCount: 0, preferenceCount: 0, constraintCount: 0, snapshotAvailable: false },
        personalStatus: { configured: false, mode: null, connectedCount: 0, connectedApps: [] },
        worldStatus: { shortlistCount: 0, incrementalWorldCount: 0, available: false },
        recentSignals: {
          pushes: [],
          feedback: [],
          incremental: { world: [], personal: [] },
          runToken: null,
          generatedAt: null,
          pendingCount: 0,
          oldestPendingAt: null,
        },
        knownGaps: ["profile.missing"],
        candidateWorldItems: [],
        dedupContext: {
          profile: null,
          personal: { status: {}, connections: [] },
          world: { shortlist: [] },
          recentSignals: {
            pushes: [],
            feedback: [],
            incremental: { world: [], personal: [] },
          },
        },
      },
      plan: {
        reasoning: "Fallback mode",
        intentsToGenerate: [
          {
            goalBasket: "life",
            objective: "Do not duplicate refs",
            whyNow: "Test coverage",
            expectedAction: "Ship it",
            evidenceRefs: ["recent.feedback", "recent.feedback", "recent.feedback"],
          },
        ],
      },
    });

    expect(packs[0]?.evidenceRefs).toEqual(["recent.feedback"]);
  });
});
