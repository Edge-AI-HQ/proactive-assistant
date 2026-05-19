import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { ReactNode } from "react";

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
      ...domProps
    } = props;
    void animate;
    void exit;
    void initial;
    void layout;
    void transition;
    void whileHover;
    void whileTap;
    return React.createElement(tag, domProps, children);
  };

  return {
    AnimatePresence: ({ children }: { children?: ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    motion: new Proxy({}, {
      get: (_target, tag) => makeMotionElement(String(tag)),
    }),
  };
});

vi.mock("@/components/ui/drawer", async () => {
  const React = await import("react");
  const Div = ({ children, ...props }: MockElementProps) => {
    const { open, onOpenChange, overlayClassName, ...domProps } = props;
    void open;
    void onOpenChange;
    void overlayClassName;
    return React.createElement("div", domProps, children);
  };

  return {
    Drawer: Div,
    DrawerContent: Div,
    DrawerDescription: Div,
    DrawerHeader: Div,
    DrawerTitle: Div,
  };
});

vi.mock("@/components/voice", () => ({
  VoiceButton: () => null,
}));

vi.mock("../browser-view/BrowserPanel", () => ({
  default: () => null,
}));

vi.mock("./CardDrawerDetail", () => ({
  DrawerDetailBody: () => null,
  executeArtifactToLovable: () => [],
}));

vi.mock("@/hooks/useBrowserSession", () => ({
  useBrowserSession: () => ({
    session: null,
    setControl: vi.fn(),
    sendInput: vi.fn(),
    refreshLiveView: vi.fn(),
    close: vi.fn(),
  }),
}));

const mockUseCardExecutionRun = vi.fn();

vi.mock("@/hooks/useCardExecutionRun", () => ({
  useCardExecutionRun: (...args: unknown[]) => mockUseCardExecutionRun(...args),
}));

import ChatDetailView, { type ChatCard } from "./ChatDetailView";

const card: ChatCard = {
  id: 1,
  category: "Work",
  title: "Done card",
  line1: "Generated from signal.",
  line2: "Sources: Gmail",
};

function makeRun(status: "done" | "error" = "done") {
  return {
    snapshot: {
      status,
      pendingInput: null,
      events: [],
      result: { summary: "Finished." },
    },
    events: [
      {
        type: "result",
        data: { summary: "Finished." },
        ts: Date.now(),
      },
    ],
    loading: false,
    error: null,
    reply: vi.fn(),
    cancel: vi.fn(),
    retry: vi.fn(async () => "run-1"),
    refresh: vi.fn(),
    confirmDone: vi.fn(),
    continueWith: vi.fn(),
    lastMessagePayload: null,
    messageCount: 0,
  };
}

describe("ChatDetailView terminal toolbar", () => {
  test("renders only a grey Close action for completed runs", () => {
    const onBack = vi.fn();
    mockUseCardExecutionRun.mockReturnValue(makeRun("done"));

    render(<ChatDetailView card={card} runId="run-1" onBack={onBack} />);

    const close = screen.getByRole("button", { name: "Close" });
    expect(close).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    expect(screen.queryByText("Was this helpful?")).toBeNull();

    fireEvent.click(close);
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
