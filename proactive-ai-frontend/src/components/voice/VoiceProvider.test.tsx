import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import { VoiceButton } from "./VoiceButton";
import { VoiceProvider } from "./VoiceProvider";
import type { VoiceEngine, VoiceEngineCallbacks } from "./types";

describe("VoiceProvider", () => {
  test("commits browser-style sync transcription without showing a finalizing state", async () => {
    const stop = vi.fn();
    const engine: VoiceEngine = {
      start(callbacks: VoiceEngineCallbacks) {
        callbacks.onPartial("测试转录");
        return { stop };
      },
    };
    const onUpdate = vi.fn();

    render(
      <VoiceProvider engine={engine}>
        <VoiceButton onUpdate={onUpdate} />
      </VoiceProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Voice input" }));
    expect(onUpdate).toHaveBeenCalledWith("测试转录");
    expect(screen.getByText("测试转录")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /done/i }));

    expect(stop).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Transcribing...")).toBeNull();
    await waitFor(() => expect(screen.queryByText("测试转录")).toBeNull());
  });

  test("waits for final stop-time transcription before committing", async () => {
    let activeCallbacks: VoiceEngineCallbacks | null = null;
    const finalText = "这是一段明显超过十个字的语音输入内容";
    const engine: VoiceEngine = {
      start(callbacks: VoiceEngineCallbacks) {
        activeCallbacks = callbacks;
        callbacks.onPartial("这是一段明显");
        return {
          stop() {
            activeCallbacks?.onFinal(finalText);
            return Promise.resolve();
          },
        };
      },
    };
    const onUpdate = vi.fn();
    const onResult = vi.fn();

    render(
      <VoiceProvider engine={engine}>
        <VoiceButton onUpdate={onUpdate} onResult={onResult} />
      </VoiceProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Voice input" }));
    fireEvent.click(screen.getByRole("button", { name: /done/i }));

    await waitFor(() => expect(onResult).toHaveBeenCalledWith(finalText));
    expect(onUpdate).toHaveBeenLastCalledWith(finalText);
  });
});
