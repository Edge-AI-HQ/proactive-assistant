import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { ComponentType, ReactNode } from "react";
import { useConversationRuntime, type UseConversationRuntimeResult } from "@pin-ai/state";

type MockElementProps = { children?: ReactNode } & Record<string, unknown>;

vi.mock("framer-motion", async () => {
  const React = await import("react");
  const makeMotionElement = (tag: string) => ({ children, ...props }: MockElementProps) => {
    const { animate, initial, transition, ...domProps } = props;
    void animate;
    void initial;
    void transition;
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

vi.mock("react-virtuoso", async () => {
  const React = await import("react");
  return {
    Virtuoso: ({ data, itemContent, context, components }: Record<string, unknown>) => {
      const renderItem = itemContent as (index: number, entry: unknown) => ReactNode;
      const Footer = (
        components as { Footer?: ComponentType<{ context?: unknown }> } | undefined
      )?.Footer;
      return React.createElement(
        "div",
        {},
        (data as unknown[]).map((entry, index) =>
          React.createElement(
            "div",
            { key: (entry as { id: string }).id },
            renderItem(index, entry),
          ),
        ),
        Footer ? React.createElement(Footer, { context }) : null,
      );
    },
  };
});

vi.mock("../../assets/bg-gradient.jpg", () => ({
  default: "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
}));
vi.mock("../../now/AiSphere", () => ({ default: () => null }));
vi.mock("../../browser/useBrowserSession", () => ({
  useBrowserSession: () => ({
    session: null,
    panelOpen: false,
    openPanel: vi.fn(),
    closePanel: vi.fn(),
    setControl: vi.fn(),
    sendInput: vi.fn(),
    refreshLiveView: vi.fn(),
    close: vi.fn(),
  }),
}));
vi.mock("../../voice", () => ({
  Waveform: () => null,
  appendVoiceTranscript: (_prev: string, final: string) => final,
  useVoiceInput: () => ({
    startCapture: vi.fn(),
    stopCapture: vi.fn(),
    captureStatus: "idle",
  }),
}));

const sendMessage = vi.fn(async () => {});
const updateQueuedMessage = vi.fn(async () => {});
const deleteQueuedMessage = vi.fn(async () => {});
const interruptQueuedMessage = vi.fn(async () => {});

vi.mock("@pin-ai/state", async () => {
  const actual = await vi.importActual<typeof import("@pin-ai/state")>("@pin-ai/state");
  return {
    ...actual,
    useConversationRuntime: vi.fn((): UseConversationRuntimeResult => ({
      transcript: [
        {
          kind: "user",
          id: "queued-1",
          ts: Date.now(),
          text: "Queued follow-up",
          clientId: "queued-1",
          queued: true,
        },
      ],
      connection: "open",
      ready: true,
      sendMessage,
      busy: true,
      retryMessage: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      updateQueuedMessage,
      deleteQueuedMessage,
      interruptQueuedMessage,
      regenerateLast: vi.fn(async () => {}),
      threadId: "main-1",
      hasMoreHistory: false,
      loadMoreHistory: vi.fn(async () => {}),
      awaitingDecision: null,
      submitDecision: vi.fn(async () => {}),
    })),
  };
});

import ConversationView from "./ConversationView";

describe("ConversationView queued user controls", () => {
  test.each([
    ["main chat", "main-1"],
    ["card chat", "card-thread-card-1"],
  ])("queued messages render above the composer in %s without a copy action", (_label, session) => {
    render(<ConversationView session={session} onBack={vi.fn()} />);

    const queue = screen.getByRole("region", { name: "Queued messages" });
    expect(within(queue).getByText("Queued follow-up")).toBeTruthy();
    expect(within(queue).getByRole("button", { name: "Edit queued message" })).toBeTruthy();
    expect(within(queue).getByRole("button", { name: "Send now" })).toBeTruthy();
    expect(within(queue).getByRole("button", { name: "Delete queued message" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy message" })).toBeNull();
    expect(useConversationRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ session }),
    );
  });

  test("composer still sends while the agent is streaming so the message can queue", async () => {
    render(<ConversationView session="main-1" onBack={vi.fn()} />);

    const box = screen.getByPlaceholderText("Message PIN AI…");
    await act(async () => {
      fireEvent.change(box, { target: { value: "another follow-up" } });
      fireEvent.keyDown(box, { key: "Enter", code: "Enter", shiftKey: false });
    });

    expect(sendMessage).toHaveBeenCalledWith("another follow-up");
  });
});
