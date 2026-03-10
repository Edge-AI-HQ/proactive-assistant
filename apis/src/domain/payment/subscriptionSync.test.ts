import test from "node:test";
import assert from "node:assert/strict";

import { isCancellationScheduledButServiceStillActive } from "./subscriptionSync.js";
import { reconcileProvisionResultsForNotification } from "./subscriptionSync_notify_results.js";

test("reconcileProvisionResultsForNotification rewrites failed results using latest container status", () => {
  const results = [
    { assistantId: 171, label: "#171", state: "failed" as const },
    { assistantId: 172, label: "#172", state: "starting" as const },
    { assistantId: 173, label: "#173", state: "failed" as const },
  ];

  const latestStatuses = new Map<number, string>([
    [171, "running"],
    [173, "creating"],
  ]);

  assert.deepEqual(reconcileProvisionResultsForNotification(results, latestStatuses), [
    { assistantId: 171, label: "#171", state: "ready" },
    { assistantId: 172, label: "#172", state: "starting" },
    { assistantId: 173, label: "#173", state: "starting" },
  ]);
});

test("isCancellationScheduledButServiceStillActive returns true before period end", () => {
  assert.equal(
    isCancellationScheduledButServiceStillActive({
      cancel_at_period_end: true,
      currentPeriodEnd: "2026-03-20T00:00:00.000Z",
      now: new Date("2026-03-10T00:00:00.000Z"),
    }),
    true,
  );
});

test("isCancellationScheduledButServiceStillActive returns false after period end", () => {
  assert.equal(
    isCancellationScheduledButServiceStillActive({
      cancel_at_period_end: true,
      currentPeriodEnd: "2026-03-09T00:00:00.000Z",
      now: new Date("2026-03-10T00:00:00.000Z"),
    }),
    false,
  );
});

test("isCancellationScheduledButServiceStillActive returns false when not scheduled for cancellation", () => {
  assert.equal(
    isCancellationScheduledButServiceStillActive({
      cancel_at_period_end: false,
      currentPeriodEnd: "2026-03-20T00:00:00.000Z",
      now: new Date("2026-03-10T00:00:00.000Z"),
    }),
    false,
  );
});
