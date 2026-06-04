import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const layoutSrc = () =>
  readFileSync(join(here, "ConstellationLayout.tsx"), "utf8");

describe("ConstellationLayout navigation behavior (characterization)", () => {
  test("menu nav clears card-chat overlays and closes the menu", () => {
    const src = layoutSrc();
    const fn = src.match(/const handleMenuNav = [\s\S]*?\n  \};/);
    expect(fn).not.toBeNull();
    const body = fn![0];
    expect(body).toContain("setActiveView(id)");
    expect(body).toContain("setActiveChat(null)");
    expect(body).toContain("setChatTarget(null)");
    expect(body).toContain("setMenuOpen(false)");
  });

  test("main chat back returns to now and closes the overlay", () => {
    const src = layoutSrc();
    const fn = src.match(/const handleMainChatBack = [\s\S]*?\n  \}/);
    expect(fn).not.toBeNull();
    expect(fn![0]).toContain('setActiveView("now")');
    expect(fn![0]).toContain("setMainChatOpen(false)");
  });

  test("card chat onBack clears chatTarget and restores entry view", () => {
    const src = layoutSrc();
    // The ChatDetailView onBack closure for the real chatTarget path.
    expect(src).toMatch(
      /onBack=\{\(\) => \{\s*const returnTo = chatEntryView\.current;\s*setChatTarget\(null\);\s*if \(returnTo\) setActiveView\(returnTo\);/,
    );
  });

  test("activeView persists to sessionStorage key 'pai-active-view'", () => {
    const src = layoutSrc();
    expect(src).toContain('sessionStorage.getItem("pai-active-view")');
    expect(src).toContain('sessionStorage.setItem("pai-active-view", v)');
  });
});
