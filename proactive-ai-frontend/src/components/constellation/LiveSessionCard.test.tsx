import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { Mic } from "lucide-react";

import LiveSessionCard from "./LiveSessionCard";
import type { LiveSession } from "@/services/ambient/live-session";

type MockElementProps = { children?: ReactNode } & Record<string, unknown>;

vi.mock("framer-motion", async () => {
  const React = await import("react");
  const makeMotionElement = (tag: string) => ({ children, ...props }: MockElementProps) => {
    const { animate, exit, initial, layout, transition, ...rest } = props;
    void animate;
    void exit;
    void initial;
    void layout;
    void transition;
    return React.createElement(tag, rest, children);
  };
  return {
    AnimatePresence: ({ children }: { children?: ReactNode }) => <>{children}</>,
    motion: { div: makeMotionElement("div") },
  };
});

function makeSession(signals: string[]): LiveSession {
  return {
    icon: Mic,
    kind: "Ambient context",
    title: "Sensing near WeWork",
    location: "Near WeWork",
    device: "iPhone",
    startedAt: "10:00",
    signals,
    assists: [{ time: "10:00", kind: "context", text: "Near WeWork · private" }],
  };
}

describe("LiveSessionCard signals", () => {
  test("renders up to five live context signal chips", () => {
    render(
      <LiveSessionCard
        session={makeSession(["Near WeWork", "Stationary", "Speech detected", "1 transcript", "Provider: local", "Extra signal"])}
        previewVisibleCount={1}
        variant="ambient"
      />,
    );

    expect(screen.getAllByText("Near WeWork").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Stationary")).toBeTruthy();
    expect(screen.getByText("Speech detected")).toBeTruthy();
    expect(screen.getByText("1 transcript")).toBeTruthy();
    expect(screen.getByText("Provider: local")).toBeTruthy();
    expect(screen.queryByText("Extra signal")).toBeNull();
  });
});
