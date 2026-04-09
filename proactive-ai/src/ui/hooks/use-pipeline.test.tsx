import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { usePipeline } from "./use-pipeline";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function streamResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });

  return new Response(body, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

function Harness() {
  const { run, generate } = usePipeline();

  return (
    <div>
      <button onClick={() => generate(1)}>Generate</button>
      <div data-testid="logs">
        {run.logEntries.map((entry) => `${entry.title} :: ${entry.detail}`).join("\n")}
      </div>
    </div>
  );
}

describe("usePipeline", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    sessionStorage.clear();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it("shows benchmark timing events in the run log", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (url.endsWith("/api/health")) {
        return jsonResponse({ ok: true, pipelineRunning: false });
      }

      if (url.endsWith("/api/status")) {
        return jsonResponse({ pipelineRunning: false, lastResult: null });
      }

      if (url.includes("/api/generate?iterations=1")) {
        return streamResponse([
          'data: {"type":"pipeline:start","data":{"maxIterations":1}}\n',
          'data: {"type":"pipeline:timing","data":{"label":"Planner:1 total","durationMs":1234,"detail":"Planner:1 total 1.2s"}}\n',
          'data: {"type":"pipeline:complete","data":{"runId":"run_1","iterations":[],"finalCards":[],"totalIterations":1}}\n',
        ]);
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    await act(async () => {
      root.render(<Harness />);
    });

    await act(async () => {
      await Promise.resolve();
    });

    const button = container.querySelector("button");
    expect(button).toBeTruthy();

    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Planner:1 total");
    expect(container.textContent).toContain("Planner:1 total 1.2s");
  });

  it("shows pipeline trace events in the run log", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (url.endsWith("/api/health")) {
        return jsonResponse({ ok: true, pipelineRunning: false });
      }

      if (url.endsWith("/api/status")) {
        return jsonResponse({ pipelineRunning: false, lastResult: null });
      }

      if (url.includes("/api/generate?iterations=1")) {
        return streamResponse([
          'data: {"type":"pipeline:start","data":{"maxIterations":1}}\n',
          'data: {"type":"pipeline:trace","data":{"phase":"context","kind":"context.summary","name":"Context summary","message":"profile missing, world shortlist 0","durationMs":18}}\n',
          'data: {"type":"pipeline:complete","data":{"runId":"run_1","iterations":[],"finalCards":[],"totalIterations":1}}\n',
        ]);
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    await act(async () => {
      root.render(<Harness />);
    });

    await act(async () => {
      await Promise.resolve();
    });

    const button = container.querySelector("button");
    expect(button).toBeTruthy();

    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Context summary");
    expect(container.textContent).toContain("profile missing, world shortlist 0");
  });
});
