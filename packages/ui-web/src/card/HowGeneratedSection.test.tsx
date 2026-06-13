// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { HowGeneratedSection } from "./CardDrawerBody";

describe("HowGeneratedSection", () => {
  test("renders nothing when there are no steps", () => {
    const { container } = render(<HowGeneratedSection steps={[]} />);
    expect(container.firstChild).toBeNull();
  });

  test("shows header count and numbered steps with display labels", async () => {
    render(
      <HowGeneratedSection
        steps={[
          { label: "observed", detail: "Saw the selloff signal." },
          { label: "decided", detail: "Surfaced this card." },
        ]}
      />,
    );
    expect(screen.getByText("How I reasoned")).toBeTruthy();
    expect(screen.getByText("· 2 steps")).toBeTruthy();
    // 默认收起;点开后步骤可见(断言风格对齐 HitlApprovalCard.test.tsx,
    // 仓库未装 @testing-library/jest-dom,不用 toBeInTheDocument)
    fireEvent.click(screen.getByRole("button"));
    expect(await screen.findByText("Observed")).toBeTruthy();
    expect(await screen.findByText("Saw the selloff signal.")).toBeTruthy();
  });
});
