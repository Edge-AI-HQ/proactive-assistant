import { afterEach, describe, expect, test, vi } from "vitest";

import { isPinLocalDevAuthEnabled } from "./dev-auth";

describe("isPinLocalDevAuthEnabled", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("enabled on the dev server when the flag is set", () => {
    vi.stubEnv("VITE_PIN_LOCAL_DEV_AUTH", "1");
    vi.stubEnv("DEV", true);

    expect(isPinLocalDevAuthEnabled()).toBe(true);
  });

  test("disabled in a built artifact even when the flag leaked in", () => {
    // A `vite build` output (native Capacitor bundle / production web build)
    // has import.meta.env.DEV === false. A VITE_PIN_LOCAL_DEV_AUTH=1 that
    // leaks into such a build (e.g. a polluted shell during build-ios.sh)
    // must NOT resolve to the synthetic "Local Dev User".
    vi.stubEnv("VITE_PIN_LOCAL_DEV_AUTH", "1");
    vi.stubEnv("DEV", false);

    expect(isPinLocalDevAuthEnabled()).toBe(false);
  });

  test("disabled when the flag is absent", () => {
    vi.stubEnv("VITE_PIN_LOCAL_DEV_AUTH", "");
    vi.stubEnv("DEV", true);

    expect(isPinLocalDevAuthEnabled()).toBe(false);
  });
});
