import { describe, expect, it } from "vitest";

import { buildTopDragRegionCss } from "../../../electron/drag-region";

describe("buildTopDragRegionCss", () => {
  it("reserves a right-side safe zone for top-right controls", () => {
    const css = buildTopDragRegionCss();

    expect(css).toContain("height: 38px;");
    expect(css).toContain("right: 64px;");
    expect(css).not.toContain("right: 0;");
  });
});
