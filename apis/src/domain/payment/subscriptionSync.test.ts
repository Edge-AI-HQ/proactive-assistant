import test from "node:test";
import assert from "node:assert/strict";

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
