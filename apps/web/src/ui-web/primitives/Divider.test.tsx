import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";

import { Divider } from "./Divider";

describe("Divider primitive (web)", () => {
  it("默认 horizontal:separator role + border 色 + 1px 高", () => {
    render(<Divider />);
    const el = screen.getByRole("separator");
    expect(el.getAttribute("aria-orientation")).toBe("horizontal");
    expect(el.className).toContain("bg-border");
    expect(el.className).toContain("h-px");
  });

  it("vertical → w-px", () => {
    render(<Divider orientation="vertical" />);
    expect(screen.getByRole("separator").className).toContain("w-px");
  });
});
