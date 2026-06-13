import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import OnboardingFlow from "./OnboardingFlow";

vi.mock("@/lib/platform", () => ({ isNative: true }));
vi.mock("@/components/ambient/AmbientSourceControlsPanel", () => ({ default: () => <div>Ambient controls</div> }));
vi.mock("@/components/account/VoiceIdentitySettings", () => ({ default: () => <div>Voice identity</div> }));
vi.mock("@/components/connect/DataConnections", () => ({ default: () => <div>Data connections</div> }));
vi.mock("@/components/connect/ConnectorOnboardingInsight", () => ({
  default: ({
    mode,
    onStatusChange,
    onContinue,
    continueLabel = "Continue setup",
  }: {
    mode?: string;
    onStatusChange?: (status: "hidden" | "pending" | "ready", insightKey: string | null) => void;
    onContinue?: () => void;
    continueLabel?: string;
  }) => (
    <div>
      <div>Connector insight {mode}</div>
      <button type="button" onClick={() => onStatusChange?.("hidden", null)}>
        Trigger hidden insight
      </button>
      <button type="button" onClick={() => onStatusChange?.("pending", "insight-1")}>
        Trigger pending insight
      </button>
      <button type="button" onClick={() => onStatusChange?.("ready", "insight-1")}>
        Trigger ready insight
      </button>
      {mode === "page" && (
        <button type="button" onClick={onContinue}>
          {continueLabel}
        </button>
      )}
    </div>
  ),
}));
vi.mock("@/hooks/useComposio", () => ({ useComposio: () => ({}) }));
vi.mock("./AmbientModelSetupStep", () => ({ default: () => <div>Gemma 2B setup</div> }));

describe("OnboardingFlow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("starts with data connections so connector summaries can run during later setup", () => {
    render(<OnboardingFlow onComplete={vi.fn()} />);

    expect(screen.getByText(/Step 1 of 3/i)).toBeTruthy();
    expect(screen.getByText(/Connect your data/i)).toBeTruthy();
    expect(screen.getByText(/Data connections/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /next/i }));

    expect(screen.getByText(/Step 2 of 3/i)).toBeTruthy();
    expect(screen.getByText(/Ambient setup/i)).toBeTruthy();
    expect(screen.getByText(/Ambient controls/i)).toBeTruthy();
    expect(screen.getByText(/Voice identity/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(screen.getByText(/Step 3 of 3/i)).toBeTruthy();
    expect(screen.getByText(/On-device AI model/i)).toBeTruthy();
    expect(screen.getByText(/Gemma 2B setup/i)).toBeTruthy();
    expect(screen.getByText(/Connector insight/i)).toBeTruthy();
  });

  test("keeps setup moving and shows ready insight after the final step", async () => {
    const onComplete = vi.fn();
    render(<OnboardingFlow onComplete={onComplete} />);

    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(screen.getByText(/Step 2 of 3/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /trigger ready insight/i }));
    expect(screen.getByText(/Step 2 of 3/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    fireEvent.click(screen.getByRole("button", { name: /done/i }));
    expect(screen.getByText(/Connector insight page/i)).toBeTruthy();
    expect(onComplete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /enter pin ai/i }));

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledTimes(1);
    });
  });

  test("waits on the final step until connector insight is ready", async () => {
    vi.useFakeTimers();
    const onComplete = vi.fn();
    render(<OnboardingFlow onComplete={onComplete} />);

    fireEvent.click(screen.getByRole("button", { name: /trigger pending insight/i }));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    fireEvent.click(screen.getByRole("button", { name: /done/i }));

    expect(screen.queryByText(/PIN AI is getting to know your work context/i)).toBeFalsy();

    await act(async () => {
      vi.advanceTimersByTime(900);
    });

    expect(screen.getByText(/PIN AI is getting to know your work context/i)).toBeTruthy();
    expect(onComplete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /trigger ready insight/i }));

    expect(screen.getByText(/Connector insight page/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /enter pin ai/i }));
    await act(async () => {});
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  test("does not flash waiting when pending insight becomes ready right after done", () => {
    vi.useFakeTimers();
    const onComplete = vi.fn();
    render(<OnboardingFlow onComplete={onComplete} />);

    fireEvent.click(screen.getByRole("button", { name: /trigger pending insight/i }));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    fireEvent.click(screen.getByRole("button", { name: /done/i }));

    expect(screen.queryByText(/PIN AI is getting to know your work context/i)).toBeFalsy();

    fireEvent.click(screen.getByRole("button", { name: /trigger ready insight/i }));

    expect(screen.getByText(/Connector insight page/i)).toBeTruthy();
    expect(screen.queryByText(/PIN AI is getting to know your work context/i)).toBeFalsy();
  });

  test("finishes if a pending connector insight disappears after done", async () => {
    vi.useFakeTimers();
    const onComplete = vi.fn();
    render(<OnboardingFlow onComplete={onComplete} />);

    fireEvent.click(screen.getByRole("button", { name: /trigger pending insight/i }));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    fireEvent.click(screen.getByRole("button", { name: /done/i }));
    fireEvent.click(screen.getByRole("button", { name: /trigger hidden insight/i }));

    await act(async () => {});
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/PIN AI is getting to know your work context/i)).toBeFalsy();
  });

  test("finishes directly when no connector insight is available", async () => {
    const onComplete = vi.fn();
    render(<OnboardingFlow onComplete={onComplete} />);

    fireEvent.click(screen.getByRole("button", { name: /trigger hidden insight/i }));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    fireEvent.click(screen.getByRole("button", { name: /done/i }));

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByText(/Connector insight page/i)).toBeFalsy();
    expect(screen.queryByText(/PIN AI is getting to know your work context/i)).toBeFalsy();
  });
});
