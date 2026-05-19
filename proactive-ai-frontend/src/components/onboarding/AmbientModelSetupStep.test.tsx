import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import AmbientModelSetupStep from "./AmbientModelSetupStep";
import { AmbientAi } from "@pin/capacitor-ambient-ai";

const mockControls = vi.hoisted(() => ({
  emit: (_eventName: "modelDownloadDone", _event: unknown) => {},
  reset: () => {},
  setListResult: (_profiles: Array<Record<string, unknown>>, _statuses: Array<Record<string, unknown>>) => {},
}));

vi.mock("@pin/capacitor-ambient-ai", () => {
  type Listener = (event: unknown) => void;
  const listeners = new Map<string, Set<Listener>>();
  let listResult: { profiles: unknown[]; statuses: unknown[] } = { profiles: [], statuses: [] };
  const AmbientAi = {
    models: {
      list: vi.fn(() => Promise.resolve(listResult)),
      startDownload: vi.fn(() => Promise.resolve()),
      verifyModel: vi.fn(() => Promise.resolve({ id: "gemma-2-2b-q4", ok: true, elapsedMs: 10 })),
    },
    addListener: vi.fn((eventName: string, listener: Listener) => {
      const set = listeners.get(eventName) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(eventName, set);
      return Promise.resolve({ remove: vi.fn(() => Promise.resolve()) });
    }),
  };
  mockControls.emit = (eventName, event) => listeners.get(eventName)?.forEach((listener) => listener(event));
  mockControls.reset = () => {
    listeners.clear();
    listResult = { profiles: [], statuses: [] };
    AmbientAi.models.list.mockClear();
    AmbientAi.models.startDownload.mockClear();
    AmbientAi.models.verifyModel.mockClear();
    AmbientAi.addListener.mockClear();
  };
  mockControls.setListResult = (profiles, statuses) => {
    listResult = { profiles, statuses };
  };
  return { AmbientAi };
});

const gemmaProfile = {
  id: "gemma-2-2b-q4",
  kind: "llm",
  displayName: "Gemma 2 2B IT (Q4_K_M)",
  repo: "unsloth/gemma-2-it-GGUF",
  file: "gemma-2-2b-it.q4_k_m.gguf",
  approxBytes: 1_700_000_000,
  magic: "GGUF",
  notes: "Recommended for Ambient summaries.",
};

const absentGemma = {
  id: "gemma-2-2b-q4",
  state: "absent",
  bytesWritten: 0,
  bytesTotal: 1_700_000_000,
};

describe("AmbientModelSetupStep", () => {
  beforeEach(() => {
    mockControls.reset();
    localStorage.clear();
  });

  test("renders Gemma 2B as the recommended onboarding LLM", async () => {
    mockControls.setListResult([gemmaProfile], [absentGemma]);

    render(<AmbientModelSetupStep />);

    expect(AmbientAi.models.list).toHaveBeenCalled();
    expect(await screen.findByRole("heading", { name: /Gemma 2B/i })).toBeTruthy();
    expect(screen.getByText(/private local summaries/i)).toBeTruthy();
  });

  test("downloads Gemma 2B through the frontend startDownload facade", async () => {
    mockControls.setListResult([gemmaProfile], [absentGemma]);
    render(<AmbientModelSetupStep />);

    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /download gemma 2b/i }));
    });

    expect(AmbientAi.models.startDownload).toHaveBeenCalledWith({
      id: "gemma-2-2b-q4",
      preferredMirror: "hf-mirror",
    });
  });

  test("verifies and selects Gemma 2B when download completes", async () => {
    mockControls.setListResult([gemmaProfile], [absentGemma]);
    render(<AmbientModelSetupStep />);
    await screen.findByRole("button", { name: /download gemma 2b/i });

    await act(async () => {
      mockControls.emit("modelDownloadDone", {
        id: "gemma-2-2b-q4",
        state: "present",
        bytesWritten: 1_700_000_000,
        bytesTotal: 1_700_000_000,
        emittedAt: Date.now(),
      });
    });

    await waitFor(() => {
      expect(AmbientAi.models.verifyModel).toHaveBeenCalledWith({ id: "gemma-2-2b-q4" });
    });
    expect(localStorage.getItem("pinai:ambient-models-selected-id")).toBe("gemma-2-2b-q4");
  });
});
