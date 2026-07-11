import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";

import { Text } from "./Text";

describe("Text primitive (web)", () => {
  it("variant + weight 投影成 typeScale 字号与 CSS font-weight", () => {
    render(
      <Text variant="title" weight="semibold">
        Hello
      </Text>,
    );
    const el = screen.getByText("Hello");
    expect(el.style.fontSize).toBe("24px");
    expect(el.style.fontWeight).toBe("600");
  });

  it("默认 body / regular", () => {
    render(<Text>Body</Text>);
    const el = screen.getByText("Body");
    expect(el.style.fontSize).toBe("15px");
    expect(el.style.fontWeight).toBe("400");
  });

  it("语义色走 token className（不进 inline style）", () => {
    render(<Text color="muted">Muted</Text>);
    expect(screen.getByText("Muted").className).toContain("text-muted-foreground");
  });

  it("numberOfLines=1 单行省略", () => {
    render(<Text numberOfLines={1}>One</Text>);
    expect(screen.getByText("One").style.textOverflow).toBe("ellipsis");
  });

  it("numberOfLines>1 多行 line-clamp", () => {
    render(<Text numberOfLines={2}>Two</Text>);
    const el = screen.getByText("Two");
    expect(el.style.getPropertyValue("-webkit-line-clamp")).toBe("2");
  });
});
