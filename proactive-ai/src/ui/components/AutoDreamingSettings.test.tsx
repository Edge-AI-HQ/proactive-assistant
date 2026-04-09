import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AutoDreamingSettings from "./AutoDreamingSettings";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("AutoDreamingSettings", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it("loads the saved toggle and persists changes", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        enabled: true,
        schedule: { type: "daily", hour: 6, minute: 0, timezone: "Asia/Shanghai" },
      }))
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        runs: [],
      }))
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        enabled: false,
        schedule: { type: "daily", hour: 6, minute: 0, timezone: "Asia/Shanghai" },
      }));

    await act(async () => {
      root.render(<AutoDreamingSettings />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const toggle = container.querySelector('button[aria-label="Auto dreaming"]') as HTMLButtonElement | null;
    expect(toggle).toBeTruthy();
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).toContain("Runs every day at 6:00 AM");

    await act(async () => {
      toggle?.click();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/proactive-ai/api/settings/auto-dreaming",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ enabled: false }),
      }),
    );
  });

  it("loads history, opens detail, and applies profile changes", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        enabled: false,
        schedule: { type: "daily", hour: 6, minute: 0, timezone: "Asia/Shanghai" },
      }))
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        runs: [],
      }))
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        runs: [
          { id: "dream_1", status: "completed", trigger: "manual", startedAt: "2026-04-09T01:00:00.000Z", appliedAt: null },
        ],
      }))
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        run: { id: "dream_1", status: "completed", trigger: "manual", startedAt: "2026-04-09T01:00:00.000Z", appliedAt: null },
        detail: {
          rawInputs: { personal: { connectors: {} } },
          normalizedInputs: { personal: [] },
          summary: { kind: "updated", text: "Dream complete" },
          dreamMarkdownPath: "/tmp/dream_1/dream.md",
          dreamMarkdown: "昨天我注意到你在邮箱里收到一封重要邮件。",
          sourceBreakdown: [
            { sourceId: "personal", status: "ok", itemCount: 1, connectors: [{ connectorId: "gmail", status: "ok", itemCount: 1 }] },
          ],
          profileDelta: {
            facts: { before: {}, after: { dreaming: true } },
            preferences: { before: {}, after: { dreaming: { topBasket: "work" } } },
            interests: { before: [], after: [] },
            snapshots: { before: [], after: [] },
          },
          candidates: [{ id: "cand_1", title: "Review inbox" }],
          logPath: "/tmp/dream_1/events.log",
          logText: "{\"message\":\"run_completed\"}",
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        run: { id: "dream_1", status: "completed", appliedAt: "2026-04-09T01:00:00.000Z" },
      }));

    await act(async () => {
      root.render(<AutoDreamingSettings />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const historyButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("View History"),
    ) as HTMLButtonElement | undefined;
    expect(historyButton).toBeTruthy();

    await act(async () => {
      historyButton?.click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("2026-04-09 · manual");
    expect(container.textContent).toContain("dream_1");

    const runButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("dream_1"),
    ) as HTMLButtonElement | undefined;

    await act(async () => {
      runButton?.click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Dream complete");
    expect(container.textContent).toContain("Dream Journal");
    expect(container.textContent).toContain("昨天我注意到你在邮箱里收到一封重要邮件");
    expect(container.textContent).toContain("Review inbox");
    expect(container.textContent).toContain("personal");

    const applyButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Apply Profile Changes"),
    ) as HTMLButtonElement | undefined;

    await act(async () => {
      applyButton?.click();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/proactive-ai/api/dreaming/runs/dream_1/apply-profile",
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(container.textContent).toContain("Applied");
  });

  it("opens the new run detail immediately and shows running feedback", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        enabled: false,
        schedule: { type: "daily", hour: 6, minute: 0, timezone: "Asia/Shanghai" },
      }))
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        runs: [],
      }))
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        runId: "dream_2",
        status: "running",
      }, { status: 202 }))
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        runs: [
          { id: "dream_2", status: "running", trigger: "manual", appliedAt: null },
        ],
      }))
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        run: { id: "dream_2", status: "running", appliedAt: null, startedAt: "2026-04-09T01:00:00.000Z" },
        detail: {
          rawInputs: {},
          normalizedInputs: {},
          summary: { kind: "running", text: "Dreaming is collecting inputs and writing logs." },
          dreamMarkdownPath: null,
          dreamMarkdown: "",
          sourceBreakdown: [],
          profileDelta: {
            facts: { before: {}, after: {} },
            preferences: { before: {}, after: {} },
            interests: { before: [], after: [] },
            snapshots: { before: [], after: [] },
          },
          candidates: [],
          logPath: "/tmp/dream_2/events.log",
          logText: "{\"message\":\"run_started\"}",
        },
      }));

    await act(async () => {
      root.render(<AutoDreamingSettings />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const runButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Run Dreaming"),
    ) as HTMLButtonElement | undefined;

    await act(async () => {
      runButton?.click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Dream Run Detail");
    expect(container.textContent).toContain("running");
    expect(container.textContent).toContain("Dreaming is collecting inputs and writing logs.");
    expect(container.textContent).toContain("Waiting For Completion");
  });
});
