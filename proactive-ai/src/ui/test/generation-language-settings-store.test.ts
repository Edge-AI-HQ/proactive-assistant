import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getGenerationLanguage, saveGenerationLanguage } from "../../server/local-settings";

describe("generation language local settings", () => {
  it("defaults to english when the config file is missing or invalid", () => {
    const missingPath = join(mkdtempSync(join(tmpdir(), "proactive-ai-language-")), "local-settings.json");
    expect(getGenerationLanguage(missingPath)).toBe("en");

    const invalidPath = join(mkdtempSync(join(tmpdir(), "proactive-ai-language-")), "local-settings.json");
    writeFileSync(invalidPath, JSON.stringify({ generation: { language: "invalid" } }), "utf-8");
    expect(getGenerationLanguage(invalidPath)).toBe("en");
  });

  it("merges generation language without overwriting composio settings", () => {
    const settingsPath = join(mkdtempSync(join(tmpdir(), "proactive-ai-language-")), "local-settings.json");
    writeFileSync(settingsPath, JSON.stringify({
      composio: {
        apiKey: "ak_test_123",
        callbackUrl: "https://example.com/callback",
      },
    }, null, 2));

    saveGenerationLanguage("fr", settingsPath);

    const saved = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      composio?: { apiKey?: string; callbackUrl?: string };
      generation?: { language?: string };
    };

    expect(saved.composio?.apiKey).toBe("ak_test_123");
    expect(saved.composio?.callbackUrl).toBe("https://example.com/callback");
    expect(saved.generation?.language).toBe("fr");
    expect(getGenerationLanguage(settingsPath)).toBe("fr");
  });
});
