import { describe, expect, it } from "vitest";

import {
  deriveCardUiStatus,
  parseCardRunStatus,
  type DeriveCardUiStatusArgs,
} from "./card-run-status";

function args(overrides: Partial<DeriveCardUiStatusArgs>): DeriveCardUiStatusArgs {
  return {
    runStatus: null,
    latestOutcome: null,
    optimisticProcessing: false,
    chatted: false,
    ...overrides,
  };
}

describe("parseCardRunStatus", () => {
  it("accepts the pai_agent_runs status enum", () => {
    for (const s of [
      "pending",
      "running",
      "awaiting_input",
      "succeeded",
      "failed",
      "cancelled",
    ]) {
      expect(parseCardRunStatus(s)).toBe(s);
    }
  });

  it("rejects unknown / non-string values", () => {
    expect(parseCardRunStatus("done")).toBeNull();
    expect(parseCardRunStatus(42)).toBeNull();
    expect(parseCardRunStatus(null)).toBeNull();
    expect(parseCardRunStatus(undefined)).toBeNull();
  });
});

describe("deriveCardUiStatus", () => {
  it("never surfaces execution state for an untouched card (fanout pre-run)", () => {
    // The generator pre-runs top cards; without user engagement the card
    // must stay normal no matter what its thread's runs say.
    for (const runStatus of ["running", "awaiting_input", "succeeded", "failed"] as const) {
      expect(deriveCardUiStatus(args({ runStatus }))).toBe("normal");
    }
  });

  it("maps server states for an engaged card (relaunch path)", () => {
    // latestOutcome=confirm survives an app kill — this is what restores the
    // spinner / ready / failed marks after relaunch.
    const engaged = { latestOutcome: "confirm" };
    expect(deriveCardUiStatus(args({ ...engaged, runStatus: "pending" }))).toBe("processing");
    expect(deriveCardUiStatus(args({ ...engaged, runStatus: "running" }))).toBe("processing");
    expect(deriveCardUiStatus(args({ ...engaged, runStatus: "awaiting_input" }))).toBe(
      "needs_input",
    );
    expect(deriveCardUiStatus(args({ ...engaged, runStatus: "succeeded" }))).toBe("ready");
    expect(deriveCardUiStatus(args({ ...engaged, runStatus: "failed" }))).toBe("failed");
    expect(deriveCardUiStatus(args({ ...engaged, runStatus: "cancelled" }))).toBe("normal");
  });

  it("treats modify (Steer) as engagement", () => {
    expect(
      deriveCardUiStatus(args({ latestOutcome: "modify", runStatus: "running" })),
    ).toBe("processing");
  });

  it("falls back to the optimistic spinner only when no run row exists yet", () => {
    // Confirm just happened: feedback + send POSTed, run row not yet visible.
    expect(deriveCardUiStatus(args({ optimisticProcessing: true }))).toBe("processing");
  });

  it("lets server terminal state beat a stale optimistic spinner", () => {
    // Confirm on a card whose fanout pre-run already finished: no new send
    // fires (thread non-empty), so the optimistic flag would never clear —
    // the server's succeeded must win or the spinner runs forever.
    expect(
      deriveCardUiStatus(args({ optimisticProcessing: true, runStatus: "succeeded" })),
    ).toBe("ready");
  });

  it("chatted alone exposes the thread's state", () => {
    expect(deriveCardUiStatus(args({ chatted: true, runStatus: "running" }))).toBe(
      "processing",
    );
    expect(deriveCardUiStatus(args({ chatted: true }))).toBe("normal");
  });
});
