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

vi.mock("./CardDrawerBody", () => ({
  DrawerDetailBody: () => null,
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

const mockConversationView = vi.fn();

// ChatDetailView imports only TYPES from useCardExecutionRun (the live view
// renders ConversationView, not the legacy run hook). Stub the module so the
// import resolves without pulling the real hook into the test.
vi.mock("@/hooks/useCardExecutionRun", () => ({
  useCardExecutionRun: vi.fn(),
}));

vi.mock("@/components/chat/conversation/ConversationView", async () => {
  const React = await import("react");
  return {
    default: (props: Record<string, unknown>) => {
      mockConversationView(props);
      return React.createElement(
        "div",
        {
          "data-testid": "conversation-view",
          "data-session-key": String(props.session ?? ""),
          "data-title": String(props.title ?? ""),
        },
        props.headerSlot as ReactNode,
      );
    },
  };
});

import ChatDetailView, { type ChatCard } from "@/components/chat/ChatDetailView";

const card: ChatCard = {
  id: 1,
  category: "Work",
  title: "Done card",
  line1: "Generated from signal.",
  line2: "Sources: Gmail",
};

describe("ChatDetailView", () => {
  test("renders card chat through the unified ConversationView", () => {
    const onBack = vi.fn();

    render(
      <ChatDetailView
        card={card}
        runId="run-1"
        bootstrap="Approve this card"
        onBack={onBack}
      />,
    );

    expect(screen.getByTestId("conversation-view")).toBeTruthy();
    expect(screen.getByTestId("conversation-view").dataset.sessionKey).toBe(
      "card-thread-run-1",
    );
    expect(screen.getByTestId("conversation-view").dataset.title).toBe(
      "Done card",
    );
    expect(mockConversationView).toHaveBeenCalledWith(
      expect.objectContaining({
        session: "card-thread-run-1",
        title: "Done card",
        bootstrap: "Approve this card",
        onBack,
        cardContext: expect.objectContaining({
          title: "Done card",
          summary: "Generated from signal.",
        }),
      }),
    );
    expect(screen.getByRole("button", { name: "View card details" })).toBeTruthy();
    expect(screen.getAllByText("Generated from signal.")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });
});
