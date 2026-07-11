import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";

import { Icon } from "./Icon";

/** lucide 形状的假图标:把 size/stroke 反映到 data-* 方便断言;color 走 className。 */
function FakeIcon(props: { size?: number; color?: string; strokeWidth?: number; className?: string }) {
  return (
    <span
      data-testid="icon"
      data-size={props.size}
      data-stroke={props.strokeWidth}
      className={props.className}
    />
  );
}

describe("Icon primitive (web)", () => {
  it("size 语义档 → px", () => {
    const { getByTestId } = render(<Icon icon={FakeIcon} size="lg" />);
    expect(getByTestId("icon").getAttribute("data-size")).toBe("20");
  });

  it("color 语义档 → token className（currentColor）", () => {
    const { getByTestId } = render(<Icon icon={FakeIcon} color="muted" />);
    expect(getByTestId("icon").className).toContain("text-muted-foreground");
  });

  it("默认 strokeWidth 1.8", () => {
    const { getByTestId } = render(<Icon icon={FakeIcon} />);
    expect(getByTestId("icon").getAttribute("data-stroke")).toBe("1.8");
  });
});
