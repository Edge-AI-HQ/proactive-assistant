import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { Box } from "./Box";

describe("Box primitive (web)", () => {
  it("默认渲染 div + 透传 className", () => {
    render(<Box className="p-2">b</Box>);
    const el = screen.getByText("b");
    expect(el.tagName).toBe("DIV");
    expect(el.className).toContain("p-2");
  });

  it("onPress → 渲染可点击 button", () => {
    const fn = vi.fn();
    render(<Box onPress={fn}>p</Box>);
    const el = screen.getByText("p");
    expect(el.tagName).toBe("BUTTON");
    el.click();
    expect(fn).toHaveBeenCalledOnce();
  });
});
