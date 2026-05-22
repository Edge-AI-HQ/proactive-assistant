import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("ChatTimeline minimalist copy", () => {
  test("matches the minimalist Tasks header copy and spacing", () => {
    const source = readFileSync(join(__dirname, "ChatTimeline.tsx"), "utf8");

    expect(source).toContain('className="flex flex-col h-full px-4 pt-14 pb-2 overflow-y-auto"');
    expect(source).toContain(">Tasks</h1>");
    expect(source).toContain(">AI is running these for you</p>");
    expect(source).not.toContain(">Timeline</h1>");
    expect(source).not.toContain("AI memory &amp; action log");
  });

  test("receives card data from the parent instead of fetching again", () => {
    const source = readFileSync(join(__dirname, "ChatTimeline.tsx"), "utf8");

    expect(source).toContain("cards: UseCardsState");
    expect(source).not.toContain("const cards = useCards()");
  });
});
