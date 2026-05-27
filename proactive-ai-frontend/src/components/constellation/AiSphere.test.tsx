import { render } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

vi.mock("@/lib/platform", () => ({ isNative: true }));

import AiSphere from "./AiSphere";

describe("constellation AiSphere", () => {
  test("renders the animated sphere video in native builds", () => {
    const { container } = render(<AiSphere />);

    expect(container.querySelector("video")).not.toBeNull();
    expect(container.querySelector('source[src="/sphere.mp4"]')).not.toBeNull();
  });
});
