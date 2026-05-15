import { afterEach, describe, expect, test } from "vitest";

import {
  getPersistedAmbientEnabled,
  setPersistedAmbientEnabled,
} from "./enabled-state";

describe("ambient enabled state", () => {
  afterEach(() => {
    localStorage.clear();
  });

  test("defaults to disabled", () => {
    expect(getPersistedAmbientEnabled()).toBe(false);
  });

  test("persists manual ambient enablement and clears it on disable", () => {
    setPersistedAmbientEnabled(true);

    expect(getPersistedAmbientEnabled()).toBe(true);

    setPersistedAmbientEnabled(false);
    expect(getPersistedAmbientEnabled()).toBe(false);
  });
});
