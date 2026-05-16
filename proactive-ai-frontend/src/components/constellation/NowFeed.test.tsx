import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import NowFeed from "./NowFeed";

type MockElementProps = { children?: ReactNode } & Record<string, unknown>;

vi.mock("framer-motion", async () => {
  const React = await import("react");
  const makeMotionElement = (tag: string) => ({ children, ...props }: MockElementProps) => {
    const {
      animate,
      exit,
      initial,
      layout,
      transition,
      whileHover,
      whileTap,
      ...rest
    } = props;
    void animate;
    void exit;
    void initial;
    void layout;
    void transition;
    void whileHover;
    void whileTap;
    return React.createElement(tag, rest, children);
  };
  return {
    AnimatePresence: ({ children }: { children?: ReactNode }) => <>{children}</>,
    motion: {
      div: makeMotionElement("div"),
      button: makeMotionElement("button"),
      span: makeMotionElement("span"),
      p: makeMotionElement("p"),
    },
  };
});
vi.mock("@/lib/platform", () => ({ isNative: false }));
vi.mock("@/hooks/useUserSettings", () => ({
  useUserSettings: () => ({
    settings: { ambientSources: {} },
  }),
}));
vi.mock("./AiLanding", () => ({ default: () => <div>landing</div> }));

describe("NowFeed live section", () => {
  afterEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  test("renders standby live section without demo scenario content", () => {
    render(<NowFeed onExecute={vi.fn()} />);

    expect(screen.getByText("Live standby")).toBeTruthy();
    expect(screen.getByText(/Waiting for ambient session/i)).toBeTruthy();
    expect(screen.queryByText(/Product review with design team/i)).toBeNull();
  });

  test("does not render the ambient dismiss control", () => {
    render(<NowFeed onExecute={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "End session" })).toBeNull();
  });
});
