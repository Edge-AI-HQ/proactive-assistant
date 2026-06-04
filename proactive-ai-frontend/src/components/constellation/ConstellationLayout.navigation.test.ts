import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const layoutSrc = () =>
  readFileSync(join(here, "ConstellationLayout.tsx"), "utf8");

// Phase-1 god-component extraction: navigation STATE + behavior (goBack,
// sessionStorage, overlay clearing) now live in useAppNavigation and are
// covered by useAppNavigation.test.tsx. These characterization tests lock
// that ConstellationLayout DELEGATES to the hook (the wiring contract),
// instead of re-implementing navigation inline.
describe("ConstellationLayout navigation wiring (characterization)", () => {
  test("drives navigation through the useAppNavigation hook", () => {
    const src = layoutSrc();
    expect(src).toContain("useAppNavigation()");
    // Inline activeView state + its sessionStorage handling moved to the hook.
    expect(src).not.toContain('sessionStorage.getItem("pai-active-view")');
  });

  test("menu nav delegates to navigateTo (which clears overlays + menu)", () => {
    const src = layoutSrc();
    const fn = src.match(/const handleMenuNav = [\s\S]*?\n  \};/);
    expect(fn).not.toBeNull();
    expect(fn![0]).toContain("navigateTo(id)");
  });

  test("card chat back delegates to closeCardChat", () => {
    const src = layoutSrc();
    expect(src).toContain("onBack={() => closeCardChat()}");
  });

  test("main chat back delegates to closeMainChat", () => {
    const src = layoutSrc();
    expect(src).toContain("onBack={() => closeMainChat()}");
  });

  test("settings panel is controlled via the hook's sub-page state", () => {
    const src = layoutSrc();
    expect(src).toContain("subPage={settingsSubPage}");
    expect(src).toContain("onSubPageChange={setSettingsSubPage}");
  });
});
