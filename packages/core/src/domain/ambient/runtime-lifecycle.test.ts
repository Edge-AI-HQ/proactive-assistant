import { describe, expect, it } from "vitest";

import { AmbientLifecycleController } from "./runtime-lifecycle";

describe("AmbientLifecycleController", () => {
  it("ignores a stale start after the user stops ambient", () => {
    const lifecycle = new AmbientLifecycleController();
    const start = lifecycle.beginStart("user-1", true);

    lifecycle.stop();

    const result = lifecycle.completeStart(start, ["sound_classifier"]);

    expect(result).toBe("cancelled");
    expect(lifecycle.running).toBe(false);
    expect(lifecycle.ownerUserId).toBeNull();
    expect(lifecycle.startedSourceKeys).toEqual([]);
  });

  it("stores non-interactive permission mode on the active start session", () => {
    const lifecycle = new AmbientLifecycleController();
    const start = lifecycle.beginStart("user-1", false);

    expect(lifecycle.isCurrentStart(start)).toBe(true);
    expect(lifecycle.interactivePermissions).toBe(false);
  });
});
