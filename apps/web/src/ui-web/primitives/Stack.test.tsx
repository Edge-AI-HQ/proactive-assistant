import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";

import { Stack, VStack, HStack, Spacer } from "./Stack";

describe("Stack primitive (web)", () => {
  it("默认 col + cva flex class", () => {
    render(<Stack>s</Stack>);
    const el = screen.getByText("s");
    expect(el.className).toContain("flex");
    expect(el.className).toContain("flex-col");
  });

  it("direction/gap → 静态 cva class（双端通用子集）", () => {
    render(
      <Stack direction="row" gap="md">
        r
      </Stack>,
    );
    const el = screen.getByText("r");
    expect(el.className).toContain("flex-row");
    expect(el.className).toContain("gap-4");
  });

  it("VStack/HStack 投影 direction", () => {
    render(
      <>
        <VStack>v</VStack>
        <HStack>h</HStack>
      </>,
    );
    expect(screen.getByText("v").className).toContain("flex-col");
    expect(screen.getByText("h").className).toContain("flex-row");
  });

  it("Spacer = flex-1 占位", () => {
    const { container } = render(<Spacer />);
    expect((container.firstChild as HTMLElement).className).toContain("flex-1");
  });
});
