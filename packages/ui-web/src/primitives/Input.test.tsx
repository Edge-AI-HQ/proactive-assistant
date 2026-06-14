import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { Input } from "./Input";

describe("Input primitive (web)", () => {
  it("onValueChange 回调 string 值", () => {
    const fn = vi.fn();
    render(<Input value="" onValueChange={fn} placeholder="p" />);
    fireEvent.change(screen.getByPlaceholderText("p"), { target: { value: "hi" } });
    expect(fn).toHaveBeenCalledWith("hi");
  });

  it("Enter 触发 onSubmit", () => {
    const fn = vi.fn();
    render(<Input onSubmit={fn} placeholder="p" />);
    fireEvent.keyDown(screen.getByPlaceholderText("p"), { key: "Enter" });
    expect(fn).toHaveBeenCalledOnce();
  });

  it("size 控制高度 class", () => {
    render(<Input size="sm" placeholder="p" />);
    expect(screen.getByPlaceholderText("p").className).toContain("h-8");
  });
});
