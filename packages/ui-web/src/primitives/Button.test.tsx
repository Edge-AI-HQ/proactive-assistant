import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { Button } from "./Button";

describe("Button primitive (web)", () => {
  it("默认 primary：渲染文字 + variant 背景 class", () => {
    render(<Button>Save</Button>);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("bg-foreground");
    expect(screen.getByText("Save")).toBeTruthy();
  });

  it("onPress 接到 onClick", () => {
    const fn = vi.fn();
    render(<Button onPress={fn}>Go</Button>);
    screen.getByRole("button").click();
    expect(fn).toHaveBeenCalledOnce();
  });

  it("disabled 透传", () => {
    render(<Button disabled>X</Button>);
    expect(screen.getByRole("button").hasAttribute("disabled")).toBe(true);
  });

  it("danger variant 用 cva 配方背景", () => {
    render(<Button variant="danger">Del</Button>);
    expect(screen.getByRole("button").className).toContain("bg-red-500");
  });

  it("size 控制尺寸 class", () => {
    render(<Button size="sm">S</Button>);
    expect(screen.getByRole("button").className).toContain("h-8");
  });
});
