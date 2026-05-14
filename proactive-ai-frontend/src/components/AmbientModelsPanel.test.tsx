import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import AmbientModelsPanel from "./AmbientModelsPanel";
import { AmbientAi } from "@pin/capacitor-ambient-ai";

interface ModelsMockControls {
  emit(eventName: "modelDownloadProgress" | "modelDownloadDone", event: unknown): void;
  reset(): void;
  setListResult(
    profiles: Array<Record<string, unknown>>,
    statuses: Array<Record<string, unknown>>,
  ): void;
  setVerifyResult(result: Record<string, unknown>): void;
}

const mockControls: ModelsMockControls = vi.hoisted(() => ({
  emit: () => {},
  reset: () => {},
  setListResult: () => {},
  setVerifyResult: () => {},
}));

vi.mock("@pin/capacitor-ambient-ai", () => {
  type Listener = (event: unknown) => void;
  const listeners = new Map<string, Set<Listener>>();
  let listResult: { profiles: unknown[]; statuses: unknown[] } = { profiles: [], statuses: [] };
  let verifyResult: Record<string, unknown> = { id: "x", ok: true, elapsedMs: 12 };

  const AmbientAi = {
    models: {
      list: vi.fn(() => Promise.resolve(listResult)),
      startDownload: vi.fn(() => Promise.resolve()),
      cancelDownload: vi.fn(() => Promise.resolve()),
      deleteModel: vi.fn(() => Promise.resolve()),
      verifyModel: vi.fn(() => Promise.resolve(verifyResult)),
    },
    addListener: vi.fn((eventName: string, listener: Listener) => {
      const set = listeners.get(eventName) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(eventName, set);
      return Promise.resolve({
        remove: vi.fn(() => {
          set.delete(listener);
          return Promise.resolve();
        }),
      });
    }),
  };

  mockControls.emit = (eventName, event) => {
    listeners.get(eventName)?.forEach((l) => l(event));
  };
  mockControls.reset = () => {
    listeners.clear();
    listResult = { profiles: [], statuses: [] };
    verifyResult = { id: "x", ok: true, elapsedMs: 12 };
    AmbientAi.models.list.mockClear();
    AmbientAi.models.startDownload.mockClear();
    AmbientAi.models.cancelDownload.mockClear();
    AmbientAi.models.deleteModel.mockClear();
    AmbientAi.models.verifyModel.mockClear();
    AmbientAi.addListener.mockClear();
  };
  mockControls.setListResult = (profiles, statuses) => {
    listResult = { profiles, statuses };
  };
  mockControls.setVerifyResult = (result) => {
    verifyResult = result;
  };

  return { AmbientAi };
});

const sampleProfiles = [
  {
    id: "whisper-base",
    kind: "asr",
    displayName: "Whisper base",
    repo: "ggerganov/whisper.cpp",
    file: "ggml-base.bin",
    approxBytes: 142_100_000,
    magic: "ggml",
    notes: "Recommended default",
  },
  {
    id: "qwen3-0_6b-q8",
    kind: "llm",
    displayName: "Qwen3 0.6B (Q8_0)",
    repo: "Qwen/Qwen3-0.6B-GGUF",
    file: "Qwen3-0.6B-Q8_0.gguf",
    approxBytes: 640_000_000,
    magic: "GGUF",
  },
];

const absentStatuses = sampleProfiles.map((p) => ({
  id: p.id,
  state: "absent",
  bytesWritten: 0,
  bytesTotal: p.approxBytes,
}));

describe("AmbientModelsPanel", () => {
  beforeEach(() => {
    mockControls.reset();
    localStorage.clear();
  });

  test("renders a single dropdown with kind-grouped options", async () => {
    mockControls.setListResult(sampleProfiles, absentStatuses);
    render(<AmbientModelsPanel />);

    const select = (await screen.findByLabelText(/^Selected model$/)) as HTMLSelectElement;
    const optgroups = select.querySelectorAll("optgroup");
    expect(optgroups.length).toBe(2);
    expect(optgroups[0].label).toMatch(/ASR/);
    expect(optgroups[1].label).toMatch(/LLM/);
    expect(select.value).toBe("whisper-base");
  });

  test("default preferred mirror is hf-mirror and persists on change", async () => {
    mockControls.setListResult(sampleProfiles, absentStatuses);
    render(<AmbientModelsPanel />);

    const select = (await screen.findByLabelText("Preferred mirror")) as HTMLSelectElement;
    expect(select.value).toBe("hf-mirror");

    fireEvent.change(select, { target: { value: "hf" } });
    expect(select.value).toBe("hf");
    expect(localStorage.getItem("pinai:ambient-models-preferred-mirror")).toBe("hf");
  });

  test("Download CTA dispatches startDownload with selected id and preferred mirror", async () => {
    mockControls.setListResult(sampleProfiles, absentStatuses);
    render(<AmbientModelsPanel />);

    const modelSelect = (await screen.findByLabelText(/^Selected model$/)) as HTMLSelectElement;
    fireEvent.change(modelSelect, { target: { value: "qwen3-0_6b-q8" } });
    expect(modelSelect.value).toBe("qwen3-0_6b-q8");

    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /^download$/i }));
    });

    expect(AmbientAi.models.startDownload).toHaveBeenCalledWith({
      id: "qwen3-0_6b-q8",
      preferredMirror: "hf-mirror",
    });
  });

  test("progress event updates percent and switches CTA to Cancel", async () => {
    mockControls.setListResult(sampleProfiles, absentStatuses);
    render(<AmbientModelsPanel />);

    await waitFor(() => {
      expect(AmbientAi.addListener).toHaveBeenCalledWith(
        "modelDownloadProgress",
        expect.any(Function),
      );
    });

    act(() => {
      mockControls.emit("modelDownloadProgress", {
        id: "whisper-base",
        state: "downloading",
        bytesWritten: 71_050_000,
        bytesTotal: 142_100_000,
        mirrorInUse: "hf-mirror",
        emittedAt: Date.now(),
      });
    });

    expect(await screen.findByText(/50%/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeTruthy();
    expect(screen.getByText(/via hf-mirror/)).toBeTruthy();
  });

  test("present state enables Verify + Delete buttons", async () => {
    mockControls.setListResult(sampleProfiles, [
      {
        id: "whisper-base",
        state: "present",
        bytesWritten: 142_100_000,
        bytesTotal: 142_100_000,
        sizeOnDisk: 142_100_000,
      },
      absentStatuses[1],
    ]);
    render(<AmbientModelsPanel />);

    await screen.findByLabelText(/^Selected model$/);
    expect(screen.getByRole("button", { name: /^verify$/i })).toBeTruthy();
    expect(screen.getByLabelText(/^Delete Whisper base$/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /re-download/i })).toBeTruthy();
  });

  test("Verify dispatches verifyModel and shows ok output", async () => {
    mockControls.setListResult([sampleProfiles[1]], [
      {
        id: "qwen3-0_6b-q8",
        state: "present",
        bytesWritten: 640_000_000,
        bytesTotal: 640_000_000,
        sizeOnDisk: 640_000_000,
      },
    ]);
    mockControls.setVerifyResult({
      id: "qwen3-0_6b-q8",
      ok: true,
      elapsedMs: 1234,
      output: "Qwen3 0.6B replied: \"hi\"",
    });
    render(<AmbientModelsPanel />);

    await screen.findByLabelText(/^Selected model$/);
    const verifyBtn = await screen.findByRole("button", { name: /^verify$/i });
    await act(async () => {
      fireEvent.click(verifyBtn);
    });

    expect(AmbientAi.models.verifyModel).toHaveBeenCalledWith({ id: "qwen3-0_6b-q8" });
    expect(await screen.findByText(/verified: Qwen3 0\.6B replied/)).toBeTruthy();
  });

  test("failed state surfaces error and Retry CTA", async () => {
    mockControls.setListResult([sampleProfiles[0]], [
      {
        id: "whisper-base",
        state: "failed",
        bytesWritten: 12_000_000,
        bytesTotal: 142_100_000,
        errorMessage: "HTTP 403",
      },
    ]);
    render(<AmbientModelsPanel />);

    expect(await screen.findByText("HTTP 403")).toBeTruthy();
    expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
  });
});
