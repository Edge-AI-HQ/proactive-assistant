import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadOrCreateUserId, loadPlatformSettings } from "./platform_settings.js";

const HOME_DIR = "/tmp/proactive-core-platform-settings-home";
const LEAKED_ROOT = "/tmp/proactive-core-platform-settings-leaked-root";

afterEach(() => {
  rmSync(HOME_DIR, { recursive: true, force: true });
  rmSync(LEAKED_ROOT, { recursive: true, force: true });
  delete process.env.PIN_DATA_ROOT;
});

describe("platform settings env resolution", () => {
  it("prefers the caller env over global process PIN_DATA_ROOT", () => {
    mkdirSync(join(HOME_DIR, ".openclaw-proactive-ai"), { recursive: true });
    mkdirSync(LEAKED_ROOT, { recursive: true });

    writeFileSync(join(HOME_DIR, ".openclaw-proactive-ai", "local-settings.json"), JSON.stringify({
      composio: {
        apiKey: "ak_home",
        userId: "11111111-1111-4111-8111-111111111111",
      },
    }) + "\n");
    writeFileSync(join(LEAKED_ROOT, "local-settings.json"), JSON.stringify({
      composio: {
        apiKey: "ak_leaked",
        userId: "22222222-2222-4222-8222-222222222222",
      },
    }) + "\n");

    process.env.PIN_DATA_ROOT = LEAKED_ROOT;

    expect(loadPlatformSettings(HOME_DIR, {})).toMatchObject({
      apiKey: "ak_home",
      userId: "11111111-1111-4111-8111-111111111111",
    });
    expect(loadOrCreateUserId(HOME_DIR, {})).toBe("11111111-1111-4111-8111-111111111111");
  });
});
