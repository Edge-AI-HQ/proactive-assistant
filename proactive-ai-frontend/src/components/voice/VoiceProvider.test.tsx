import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
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

  test("clears the overlay transcript when a new capture opens", async () => {
    let starts = 0;
    const engine: VoiceEngine = {
      start(callbacks: VoiceEngineCallbacks) {
        starts += 1;
        if (starts === 1) callbacks.onPartial("上一次残留文字");
        return { stop: vi.fn(), cancel: vi.fn() };
      },
    };

    render(
      <VoiceProvider engine={engine}>
        <VoiceButton />
      </VoiceProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Voice input" }));
    expect(screen.getByText("上一次残留文字")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByText("上一次残留文字")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Voice input" }));
    expect(screen.getByText("Listening...")).toBeTruthy();
    expect(screen.queryByText("上一次残留文字")).toBeNull();
  });

  test("appends transcription to the current input instead of replacing it", async () => {
    const engine: VoiceEngine = {
      start(callbacks: VoiceEngineCallbacks) {
        callbacks.onPartial("新的语音");
        return { stop: vi.fn() };
      },
    };

    function Harness() {
      const [value, setValue] = useState("已有内容");
      return (
        <VoiceProvider engine={engine}>
          <input aria-label="reply" value={value} onChange={(e) => setValue(e.target.value)} />
          <VoiceButton prefill={value} onUpdate={setValue} />
        </VoiceProvider>
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Voice input" }));

    expect((screen.getByLabelText("reply") as HTMLInputElement).value).toBe("已有内容 新的语音");
    expect(screen.getByText("新的语音")).toBeTruthy();
  });
});
