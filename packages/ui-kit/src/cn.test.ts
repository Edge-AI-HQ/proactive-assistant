import { describe, it, expect } from "vitest";

import { cn } from "./cn";

describe("cn", () => {
  it("条件拼接：falsy 值被丢弃", () => {
    expect(cn("a", false && "b", undefined, "c")).toBe("a c");
  });

  it("tailwind 冲突消解：后者覆盖前者", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
  });
});
