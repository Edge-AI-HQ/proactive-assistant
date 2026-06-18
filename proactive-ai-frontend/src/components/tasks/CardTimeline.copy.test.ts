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
    expect(source).toContain('className="flex flex-col h-full px-4 pb-2 overflow-y-auto overflow-x-hidden"');
    expect(source).toContain("var(--constellation-header-top");
    // i18n 后头部文案经 tasks:header.* key 渲染(en 值在 ui-web locales)。
    expect(source).toContain('{t("header.title")}</h1>');
    expect(source).toContain('{t("header.subtitle")}</p>');
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

  test("title wraps to two lines and raw citations never reach the subtitle", () => {
    const source = readFileSync(join(__dirname, "..", "tasks", "CardTimeline.tsx"), "utf8");

    expect(source).toContain("line-clamp-2");
    // 标题行不再单行截断
    expect(source).not.toMatch(/leading-snug truncate flex-1/);
    // 副标题 fallback 不再裸 join 审计引文
    expect(source).not.toContain("card.sources.join");
    expect(source).toContain("sourceAppDisplay");
  });
});
