import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  getAutoDreaming,
  saveAutoDreaming,
} from "./local-settings.js";

describe("auto dreaming local settings", () => {
  it("defaults to disabled when the config file is missing or invalid", () => {
    const missingPath = join(mkdtempSync(join(tmpdir(), "proactive-ai-dreaming-")), "local-settings.json");
    expect(getAutoDreaming(missingPath)).toBe(false);

    const invalidPath = join(mkdtempSync(join(tmpdir(), "proactive-ai-dreaming-")), "local-settings.json");
    writeFileSync(invalidPath, JSON.stringify({ autoDreaming: "yes" }), "utf-8");
    expect(getAutoDreaming(invalidPath)).toBe(false);
  });

  it("merges auto dreaming without overwriting other settings", () => {
    const settingsPath = join(mkdtempSync(join(tmpdir(), "proactive-ai-dreaming-")), "local-settings.json");
    writeFileSync(settingsPath, JSON.stringify({
      composio: { apiKey: "ak_test_123" },
      generation: { language: "ja" },
      autoGenerate: true,
    }, null, 2));

    saveAutoDreaming(true, settingsPath);

    const saved = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      composio?: { apiKey?: string };
      generation?: { language?: string };
      autoGenerate?: boolean;
      autoDreaming?: boolean;
    };

    expect(saved.composio?.apiKey).toBe("ak_test_123");
    expect(saved.generation?.language).toBe("ja");
    expect(saved.autoGenerate).toBe(true);
    expect(saved.autoDreaming).toBe(true);
    expect(getAutoDreaming(settingsPath)).toBe(true);
  });
});
