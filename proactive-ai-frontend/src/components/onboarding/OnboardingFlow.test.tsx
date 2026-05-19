import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import OnboardingFlow from "./OnboardingFlow";

vi.mock("@/lib/platform", () => ({ isNative: true }));
vi.mock("@/components/AmbientSourceControlsPanel", () => ({ default: () => <div>Ambient controls</div> }));
vi.mock("@/components/DataConnections", () => ({ default: () => <div>Data connections</div> }));
vi.mock("@/hooks/useComposio", () => ({ useComposio: () => ({}) }));
vi.mock("./AmbientModelSetupStep", () => ({ default: () => <div>Gemma 2B setup</div> }));

describe("OnboardingFlow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("includes a native Gemma 2B model setup step before data connections", () => {
    render(<OnboardingFlow onComplete={vi.fn()} />);

    expect(screen.getByText(/Step 1 of 3/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /next/i }));

    expect(screen.getByText(/Step 2 of 3/i)).toBeTruthy();
    expect(screen.getByText(/On-device AI model/i)).toBeTruthy();
    expect(screen.getByText(/Gemma 2B setup/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(screen.getByText(/Step 3 of 3/i)).toBeTruthy();
    expect(screen.getByText(/Data connections/i)).toBeTruthy();
  });
});
