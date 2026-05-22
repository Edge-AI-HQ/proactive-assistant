import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("ConstellationLayout menu order", () => {
  test("matches the minimalist constellation design nav order", () => {
    const source = readFileSync(join(__dirname, "ConstellationLayout.tsx"), "utf8");
    const menuSource = source.match(/const MENU_ITEMS = \[([\s\S]*?)\] as const;/);

    expect(menuSource).not.toBeNull();
    const labels = Array.from(menuSource?.[1].matchAll(/label: "([^"]+)"/g) ?? []).map(
      ([, label]) => label,
    );

    expect(labels).toEqual(["NOW", "AMBIENT", "TASKS", "CONNECT", "PROFILE", "SETTING"]);
  });

  test("scopes the ASK PIN AI entry to the NOW view", () => {
    const source = readFileSync(join(__dirname, "ConstellationLayout.tsx"), "utf8");

    expect(source).toMatch(
      /\{activeView === "now" && \(\s*<button[\s\S]*aria-label="Open main chat"/,
    );
  });

  test("does not add extra top padding around the TASKS view", () => {
    const source = readFileSync(join(__dirname, "ConstellationLayout.tsx"), "utf8");
    const tasksBranch = source.match(
      /\) : activeView === "chat" \? \(([\s\S]*?)\) : activeView === "ambient" \? \(/,
    );

    expect(tasksBranch).not.toBeNull();
    expect(tasksBranch?.[1]).toContain("<RealChatTimeline");
    expect(tasksBranch?.[1]).not.toContain('className="h-full overflow-y-auto pt-12"');
  });

  test("passes the shared cards state into the TASKS view", () => {
    const source = readFileSync(join(__dirname, "ConstellationLayout.tsx"), "utf8");
    const tasksBranch = source.match(
      /\) : activeView === "chat" \? \(([\s\S]*?)\) : activeView === "ambient" \? \(/,
    );

    expect(tasksBranch).not.toBeNull();
    expect(tasksBranch?.[1]).toContain("cards={cardsState}");
  });

  test("refreshes cards immediately after generation completes", () => {
    const source = readFileSync(join(__dirname, "ConstellationLayout.tsx"), "utf8");

    expect(source).toContain("const refreshCards = cardsState.refresh");
    expect(source).toContain("const lastCompleteRunIdRef = useRef<string | null>(null)");
    expect(source).toMatch(
      /if \(pipeline\.run\.status !== "complete" \|\| !pipeline\.run\.runId\) return;[\s\S]*void refreshCards\(\);/,
    );
  });
});
