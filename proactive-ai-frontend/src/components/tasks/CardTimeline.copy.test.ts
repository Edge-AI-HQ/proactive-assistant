import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("ChatTimeline minimalist copy", () => {
  test("matches the minimalist Tasks header copy and spacing", () => {
    const source = readFileSync(join(__dirname, "..", "tasks", "CardTimeline.tsx"), "utf8");

    // Top spacing moved from a hardcoded `pt-14` to the shared
    // `--constellation-header-top` CSS var (same 3.5rem default); the rest of
    // the minimalist container spacing stays on the className.
    expect(source).toContain('className="flex flex-col h-full px-4 pb-2 overflow-y-auto"');
    expect(source).toContain("var(--constellation-header-top");
    expect(source).toContain(">Tasks</h1>");
    expect(source).toContain(">AI is running these for you</p>");
    expect(source).not.toContain(">Timeline</h1>");
    expect(source).not.toContain("AI memory &amp; action log");
  });

  test("receives card data from context instead of fetching again", () => {
    const source = readFileSync(join(__dirname, "..", "tasks", "CardTimeline.tsx"), "utf8");

    // Card data/actions now arrive via CardStateContext (phase-2), not 11
    // props and not a self-owned fetch.
    expect(source).toContain("useCardState()");
    expect(source).not.toContain("useCards(");
  });
});
