import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import { VoiceProvider } from "../../voice";
import type { VoiceEngine, VoiceEngineCallbacks } from "../../voice";

import ProposeActionCard from "./ProposeActionCard";

describe("ProposeActionCard", () => {
  test("morphs the free-text slot into the inline voice bar and commits final text", async () => {
    let activeCallbacks: VoiceEngineCallbacks | null = null;
    const engine: VoiceEngine = {
      start(callbacks: VoiceEngineCallbacks) {
        activeCallbacks = callbacks;
        callbacks.onPartial("先说一半");
        return {
          stop() {
            activeCallbacks?.onFinal("先说一半，最后修正。");
            return Promise.resolve();
          },
          cancel: vi.fn(),
        };
      },
    };

    render(
      <VoiceProvider engine={engine}>
        <ProposeActionCard
          args={{ message: "Need your reply", options: ["Use option"] }}
          onReply={vi.fn()}
          busy={false}
        />
      </VoiceProvider>,
    );

    expect(screen.getByPlaceholderText("Or type your own reply...")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Voice input" }));

    expect(screen.getByText("先说一半")).toBeTruthy();
    expect(screen.queryByPlaceholderText("Or type your own reply...")).toBeNull();
    expect(screen.getByRole("button", { name: "Use transcript" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Use transcript" }));

    await waitFor(() => {
      const input = screen.getByPlaceholderText("Or type your own reply...") as HTMLInputElement;
      expect(input.value).toBe("先说一半，最后修正。");
    });
  });
});
