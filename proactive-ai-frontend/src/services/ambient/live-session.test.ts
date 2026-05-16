import { describe, expect, test, vi } from "vitest";

import {
  candidateWindowsToLiveSessionContextItems,
  liveSessionDataToSession,
  type LiveSessionData,
} from "./live-session";
import type { AmbientCandidateWindow } from "./timeline";

function makeWindow(
  overrides: Partial<AmbientCandidateWindow> & Pick<AmbientCandidateWindow, "id" | "windowType" | "startedAt">,
): AmbientCandidateWindow {
  return {
    id: overrides.id,
    localUserId: "local",
    localDate: "2026-05-15",
    windowType: overrides.windowType,
    startedAt: overrides.startedAt,
    endedAt: overrides.endedAt,
    timezone: "Asia/Shanghai",
    sourceTypes: overrides.sourceTypes ?? ["location"],
    deviceLabels: overrides.deviceLabels ?? ["iPhone"],
    rawRefs: overrides.rawRefs ?? [{ sourceType: "location", id: "raw_secret" }],
    observationIds: [],
    compactContext: overrides.compactContext ?? "raw compact context with latitude 23.1 and /private/tmp/audio.wav",
    privacyHint: overrides.privacyHint ?? "private",
    confidenceHint: overrides.confidenceHint ?? 0.7,
    salienceHint: overrides.salienceHint ?? 0.5,
    generationPolicy: overrides.generationPolicy ?? "do_not_generate",
    llmInputHash: null,
    status: overrides.status ?? "evidence",
    lastAttemptAt: null,
    attemptCount: 0,
    lastErrorCode: null,
    expiresAt: null,
    createdAt: overrides.startedAt,
    updatedAt: overrides.startedAt,
  };
}

describe("candidate window live session context", () => {
  test("sorts windows by recency before limiting", () => {
    const windows = [
      makeWindow({ id: "old", windowType: "location_update", startedAt: "2026-05-15T10:00:00.000Z", compactContext: "Location updated near Old Place." }),
      makeWindow({ id: "new", windowType: "location_update", startedAt: "2026-05-15T10:04:00.000Z", compactContext: "Location updated near New Place." }),
      makeWindow({ id: "mid", windowType: "location_update", startedAt: "2026-05-15T10:02:00.000Z", compactContext: "Location updated near Mid Place." }),
    ];

    const items = candidateWindowsToLiveSessionContextItems(windows, {
      now: new Date("2026-05-15T10:05:00.000Z"),
      maxWindows: 2,
    });

    expect(items.map((item) => item.sourceWindowIds[0])).toEqual(["new", "mid"]);
    expect(items.map((item) => item.label)).toEqual(["Near New Place", "Near Mid Place"]);
  });

  test("filters ignored and low-confidence windows but allows pending transcript windows", () => {
    const items = candidateWindowsToLiveSessionContextItems([
      makeWindow({ id: "ignored", windowType: "location_update", startedAt: "2026-05-15T10:00:00.000Z", status: "ignored", compactContext: "Location updated near Hidden." }),
      makeWindow({ id: "weak", windowType: "sound_context", startedAt: "2026-05-15T10:01:00.000Z", sourceTypes: ["sound"], confidenceHint: 0.2, compactContext: "Heard speech for 10s." }),
      makeWindow({ id: "pending-transcript", windowType: "transcript_session", startedAt: "2026-05-15T10:02:00.000Z", sourceTypes: ["transcript"], status: "pending", compactContext: "Confidential transcript text about cap table" }),
    ], { now: new Date("2026-05-15T10:03:00.000Z") });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "live-window-pending-transcript",
      label: "Conversation window active",
      privacy: "private",
    });
  });

  test("does not expose raw refs coordinates or transcript compact context", () => {
    const items = candidateWindowsToLiveSessionContextItems([
      makeWindow({
        id: "transcript",
        windowType: "transcript_session",
        startedAt: "2026-05-15T10:00:00.000Z",
        sourceTypes: ["transcript"],
        status: "pending",
        compactContext: "Discussed secret investor terms near 23.1425,113.2401 /private/tmp/audio.wav raw_secret",
      }),
      makeWindow({
        id: "place",
        windowType: "location_update",
        startedAt: "2026-05-15T10:01:00.000Z",
        compactContext: "Location updated near WeWork.",
      }),
    ], { now: new Date("2026-05-15T10:02:00.000Z") });

    const serialized = JSON.stringify(items);
    expect(serialized).toContain("Conversation window active");
    expect(serialized).toContain("Near WeWork");
    expect(serialized).not.toContain("secret investor terms");
    expect(serialized).not.toContain("23.1425");
    expect(serialized).not.toContain("113.2401");
    expect(serialized).not.toContain("/private/tmp");
    expect(serialized).not.toContain("raw_secret");
  });

  test("merges transcript messages and context items into one live session", () => {
    vi.setSystemTime(new Date("2026-05-15T10:05:00.000Z"));
    const transcript: LiveSessionData = {
      captureSessionId: "cap-1",
      startedAt: Date.parse("2026-05-15T10:00:00.000Z"),
      messages: [{ id: "m1", time: "+00:30", text: "Discussing the launch plan", source: "local" }],
    };
    const contextItems = candidateWindowsToLiveSessionContextItems([
      makeWindow({ id: "place", windowType: "location_update", startedAt: "2026-05-15T10:01:00.000Z", compactContext: "Location updated near WeWork." }),
      makeWindow({ id: "motion", windowType: "motion_state_run", startedAt: "2026-05-15T10:02:00.000Z", sourceTypes: ["motion"], privacyHint: "normal", compactContext: "Motion stationary for 18m 0s." }),
    ], { now: new Date("2026-05-15T10:05:00.000Z") });

    const session = liveSessionDataToSession(true, transcript, contextItems);

    expect(session?.title).toBe("Discussing the launch plan");
    expect(session?.location).toBe("Near WeWork");
    expect(session?.signals).toEqual(expect.arrayContaining(["Near WeWork", "Stationary", "1 transcript"]));
    expect(session?.assists.map((item) => item.text)).toEqual(expect.arrayContaining([
      "Near WeWork · private",
      "Stationary",
      "Discussing the launch plan",
    ]));
    vi.useRealTimers();
  });

  test("builds a context-only live session when transcript is absent", () => {
    const contextItems = candidateWindowsToLiveSessionContextItems([
      makeWindow({ id: "place", windowType: "location_update", startedAt: "2026-05-15T10:01:00.000Z", compactContext: "Location updated near WeWork." }),
      makeWindow({ id: "sound", windowType: "sound_context", startedAt: "2026-05-15T10:02:00.000Z", sourceTypes: ["sound"], privacyHint: "normal", compactContext: "Heard speech for 2m 0s, max confidence 72%." }),
    ], { now: new Date("2026-05-15T10:05:00.000Z") });

    const session = liveSessionDataToSession(true, null, contextItems);

    expect(session).toMatchObject({
      kind: "Ambient context",
      title: "Sensing near WeWork",
      location: "Near WeWork",
      device: "iPhone",
    });
    expect(session?.signals).toEqual(["Speech detected", "Near WeWork"]);
    expect(session?.assists).toHaveLength(2);
  });
});
