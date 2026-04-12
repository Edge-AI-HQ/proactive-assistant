import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../../../memory-debugger/src/App";

describe("Memory Debugger", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  });

  it("renders current state, memory application flow, and inspector", async () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "记忆驾驶盘" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "当前状态" })).toBeInTheDocument();
    expect(screen.getByText("记忆怎么被用上")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "当前详情" })).toBeInTheDocument();
  });

  it("switches the main data panel when a storage card is clicked", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /Generated Cards/i }));

    expect(await screen.findByRole("heading", { name: "生成卡片总览" })).toBeInTheDocument();
    const cardList = screen.getByLabelText("生成卡片列表");
    expect(within(cardList).getByText(/3 key signals from the FOMC March minutes/i)).toBeInTheDocument();
  });
});
