// @vitest-environment node

import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const currentDir = dirname(fileURLToPath(import.meta.url));
const skillsDir = resolve(currentDir, "../../skills");

describe("pin skill docs", () => {
  it("do not reference pin-shared via sibling relative paths", async () => {
    const entries = await readdir(skillsDir, { withFileTypes: true });
    const offenders: string[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith("pin-") || entry.name === "pin-shared") continue;

      const content = await readFile(join(skillsDir, entry.name, "SKILL.md"), "utf8");
      if (content.includes("../pin-shared/SKILL.md")) {
        offenders.push(entry.name);
      }
    }

    expect(offenders).toEqual([]);
  });
});
