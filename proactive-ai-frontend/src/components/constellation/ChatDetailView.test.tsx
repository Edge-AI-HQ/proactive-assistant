import { render, screen } from "@testing-library/react";
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
const mockUseProactiveChatRuntime = vi.fn();
const mockMainChatView = vi.fn();

vi.mock("@/hooks/useCardExecutionRun", () => ({
  useCardExecutionRun: (...args: unknown[]) => mockUseCardExecutionRun(...args),
}));

vi.mock("@/components/chat/useProactiveChatRuntime", () => ({
  useProactiveChatRuntime: (...args: unknown[]) =>
    mockUseProactiveChatRuntime(...args),
}));

vi.mock("@/components/main-chat/MainChatView", async () => {
  const React = await import("react");
  return {
    default: (props: Record<string, unknown>) => {
      mockMainChatView(props);
      return React.createElement(
        "div",
        {
          "data-testid": "main-chat-view",
          "data-session-key": String(props.sessionKey ?? ""),
          "data-title": String(props.title ?? ""),
        },
        props.headerSlot as ReactNode,
      );
    },
  };
});

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

describe("ChatDetailView", () => {
  test("renders card chat through the shared MainChatView runtime", () => {
    const onBack = vi.fn();
    mockUseCardExecutionRun.mockReturnValue(makeRun("done"));
    mockUseProactiveChatRuntime.mockReturnValue({
      runtime: { thread: {} },
      historyLoaded: true,
    });

    render(
      <ChatDetailView
        card={card}
        runId="run-1"
        bootstrap="Approve this card"
        onBack={onBack}
      />,
    );

    expect(screen.getByTestId("main-chat-view")).toBeTruthy();
    expect(screen.getByTestId("main-chat-view").dataset.sessionKey).toBe(
      "card-thread-run-1",
    );
    expect(screen.getByTestId("main-chat-view").dataset.title).toBe(
      "Done card",
    );
    expect(mockUseProactiveChatRuntime).toHaveBeenCalledWith({
      sessionKey: "card-thread-run-1",
      cardContext: expect.objectContaining({
        title: "Done card",
        summary: "Generated from signal.",
      }),
      bootstrapMessage: "Approve this card",
    });
    expect(mockMainChatView).toHaveBeenCalledWith(
      expect.objectContaining({
        historyLoaded: true,
        onBack,
        renderProposeActionAsText: true,
        sessionKey: "card-thread-run-1",
        title: "Done card",
      }),
    );
    expect(screen.getByRole("button", { name: "View card details" })).toBeTruthy();
    expect(screen.getAllByText("Generated from signal.")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });
});
