import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { Surface } from "./Surface";

describe("Surface primitive (web)", () => {
  it("默认 solid：cva 背景/边框 class", () => {
    render(<Surface>body</Surface>);
    const el = screen.getByText("body");
    expect(el.className).toContain("bg-card");
    expect(el.className).toContain("border-border");
  });

  it("elevation 投影成 boxShadow", () => {
    render(<Surface elevation="md">e</Surface>);
    expect(screen.getByText("e").style.boxShadow).toContain("12px");
  });

  it("glass variant 用 backdrop-filter", () => {
    render(<Surface variant="glass">g</Surface>);
    expect(screen.getByText("g").style.backdropFilter).toContain("blur");
  });

  it("onPress → 渲染可点击 button", () => {
    const fn = vi.fn();
    render(<Surface onPress={fn}>p</Surface>);
    const el = screen.getByText("p");
    expect(el.tagName).toBe("BUTTON");
    el.click();
    expect(fn).toHaveBeenCalledOnce();
  });
});
