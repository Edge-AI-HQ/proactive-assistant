import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("./styles/global.css", import.meta.url), "utf8");

function cssBlocks(selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return Array.from(styles.matchAll(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, "gs")), (match) => match[1] ?? "");
}

function hasRule(selector: string, rule: string): boolean {
  return cssBlocks(selector).some((block) => block.includes(rule));
}

describe("responsive layout semantics", () => {
  it("lets the compact top navigation scroll instead of overflowing the viewport", () => {
    expect(styles).toContain("@media (max-width: 920px)");
    expect(hasRule(".sidebar", "overflow-x: auto")).toBe(true);
    expect(hasRule(".nav-list", "overflow-x: auto")).toBe(true);
    expect(hasRule(".nav-item", "white-space: nowrap")).toBe(true);
  });

  it("stacks route toolbars on compact viewports", () => {
    expect(hasRule(".view-toolbar", "flex-direction: column")).toBe(true);
    expect(hasRule(".toolbar-actions", "justify-content: flex-start")).toBe(true);
  });

  it("keeps repeated case cards inside narrow panels", () => {
    expect(hasRule(".case-grid", "grid-template-columns: repeat(auto-fill, minmax(min(320px, 100%), 1fr))")).toBe(true);
  });

  it("prevents card meta pills from stretching dense rows", () => {
    expect(hasRule(".card-meta-line span", "max-width: 100%")).toBe(true);
    expect(hasRule(".card-meta-line span", "text-overflow: ellipsis")).toBe(true);
    expect(hasRule(".card-meta-line span", "white-space: nowrap")).toBe(true);
  });

  it("stacks dense card detail rows on compact viewports", () => {
    expect(hasRule(".timeline-item", "grid-template-columns: 1fr")).toBe(true);
    expect(hasRule(".analysis-block-head", "grid-template-columns: 36px minmax(0, 1fr)")).toBe(true);
    expect(hasRule(".trace-column-head", "grid-template-columns: 36px minmax(0, 1fr)")).toBe(true);
  });

  it("keeps score buttons usable on phone width", () => {
    expect(hasRule(".score-grid", "grid-template-columns: repeat(5, minmax(38px, 1fr))")).toBe(true);
    expect(hasRule(".score-button", "height: 36px")).toBe(true);
  });

  it("allows dense feedback event headers to wrap", () => {
    expect(hasRule(".feedback-event > div:first-child", "flex-wrap: wrap")).toBe(true);
    expect(hasRule(".feedback-event > div:first-child strong", "overflow-wrap: anywhere")).toBe(true);
  });

  it("allows backend and user text messages to wrap instead of overflowing", () => {
    expect(hasRule(".evaluation-text", "overflow-wrap: anywhere")).toBe(true);
    expect(hasRule(".feedback-event p", "overflow-wrap: anywhere")).toBe(true);
    expect(hasRule(".inline-error", "overflow-wrap: anywhere")).toBe(true);
    expect(hasRule(".inline-status", "overflow-wrap: anywhere")).toBe(true);
    expect(hasRule(".state-detail,\n.muted", "overflow-wrap: anywhere")).toBe(true);
    expect(hasRule(".profile-spotlight h2", "overflow-wrap: anywhere")).toBe(true);
    expect(hasRule(".profile-field > span,\n.pagination-bar span", "overflow-wrap: anywhere")).toBe(true);
    expect(hasRule(".profile-nested-list span", "overflow-wrap: anywhere")).toBe(true);
  });

  it("bounds raw JSON panels so expanded debug data cannot dominate the page", () => {
    expect(hasRule(".json-block", "max-height: min(520px, 70vh)")).toBe(true);
    expect(hasRule(".json-block", "overflow-y: auto")).toBe(true);
  });
});
