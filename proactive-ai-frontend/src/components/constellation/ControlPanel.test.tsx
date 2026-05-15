import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import ControlPanel from "./ControlPanel";

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

vi.mock("@/components/ui/slider", () => ({
  Slider: () => <input aria-label="personality slider" readOnly />,
}));

vi.mock("@/lib/platform", () => ({ isNative: false }));
vi.mock("./GoalsView", () => ({ default: () => <div>Goals view</div> }));
vi.mock("@/components/AmbientSourceControlsPanel", () => ({
  default: () => <section data-testid="ambient-source-controls">Ambient permissions</section>,
}));

describe("ControlPanel Ambient tab", () => {
  test("renames Models to Ambient and places source controls above on-device models", () => {
    render(<ControlPanel />);

    expect(screen.getByRole("button", { name: "Ambient" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Models" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Ambient" }));

    const sourceControls = screen.getByTestId("ambient-source-controls");
    const modelHeading = screen.getByText("On-device models");
    expect(modelHeading.closest(".glass-card-strong")).toBeTruthy();
    expect(
      sourceControls.compareDocumentPosition(modelHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText(/only available inside the iOS app/i)).toBeTruthy();
  });
});
