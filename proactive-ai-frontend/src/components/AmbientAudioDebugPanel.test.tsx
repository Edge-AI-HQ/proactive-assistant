import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import AmbientAudioDebugPanel from "./AmbientAudioDebugPanel";
import { AmbientAi } from "@pin/capacitor-ambient-ai";

interface AmbientAudioMockControls {
  emitAmbientAudioTestEvent(eventName: string, event: unknown): void;
  resetAmbientAudioMocks(): void;
}

const mockControls: AmbientAudioMockControls = vi.hoisted(() => {
  const controls: AmbientAudioMockControls = {
    emitAmbientAudioTestEvent: () => {},
    resetAmbientAudioMocks: () => {},
  };
  return controls;
});

vi.mock("@pin/capacitor-ambient-ai", () => {
  type Listener = (event: unknown) => void;
  const listeners = new Map<string, Set<Listener>>();

  const AmbientAi = {
    audio: {
      configure: vi.fn(() => Promise.resolve()),
      getState: vi.fn(() =>
        Promise.resolve({
          running: true,
          paused: false,
          capturing: true,
          suppressed: false,
        }),
      ),
      drainPendingTranscripts: vi.fn(() =>
        Promise.resolve([
          {
            platform: "ios",
            wavId: "wav-drain",
            burstId: "burst-drain",
            captureSessionId: "session-drain",
            text: "drained transcript text",
            capturedAt: "2026-05-10T10:00:00.000Z",
            durationMs: 2400,
            provider: "local_speech",
            fallback: false,
          },
        ]),
      ),
      listRecentCaptures: vi.fn(() =>
        Promise.resolve({
          captures: [
            {
              wavId: "wav-1",
              burstId: "burst-1",
              captureSessionId: "session-1",
              capturedAt: "2026-05-10T09:00:00.000Z",
              durationMs: 1500,
              byteSize: 48044,
            },
          ],
        }),
      ),
      playCapture: vi.fn(() => Promise.resolve()),
      stopPlayback: vi.fn(() => Promise.resolve()),
    },
    addListener: vi.fn((eventName: string, listener: Listener) => {
      const set = listeners.get(eventName) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(eventName, set);
      return Promise.resolve({ remove: vi.fn(() => { set.delete(listener); return Promise.resolve(); }) });
    }),
  };

  mockControls.emitAmbientAudioTestEvent = (eventName: string, event: unknown) => {
    listeners.get(eventName)?.forEach((listener) => listener(event));
  };
  mockControls.resetAmbientAudioMocks = () => {
    listeners.clear();
    vi.clearAllMocks();
  };

  return { AmbientAi };
});

describe("AmbientAudioDebugPanel", () => {
  beforeEach(() => {
    mockControls.resetAmbientAudioMocks();
    localStorage.clear();
  });

  test("uses old app-aligned default capture timings", async () => {
    render(<AmbientAudioDebugPanel />);

    expect((screen.getByLabelText("Pre-roll ms") as HTMLInputElement).value).toBe("500");
    expect((screen.getByLabelText("Post-roll ms") as HTMLInputElement).value).toBe("10000");
    expect((screen.getByLabelText("Max burst ms") as HTMLInputElement).value).toBe("30000");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /apply audio config/i }));
    });

    expect(AmbientAi.audio.configure).toHaveBeenCalledWith(expect.objectContaining({
      preRollMs: 500,
      postRollMs: 10000,
      maxBurstMs: 30000,
    }));
  });

  test("configures audio capture with dev cloud and WAV retention fields", async () => {
    render(<AmbientAudioDebugPanel />);

    fireEvent.change(screen.getByLabelText("Cloud mode"), { target: { value: "devDirect" } });
    fireEvent.change(screen.getByLabelText("Recognition language"), { target: { value: "zh-CN" } });
    fireEvent.change(screen.getByLabelText("Cloud API key"), { target: { value: "sk-dev" } });
    fireEvent.change(screen.getByLabelText("Model name"), { target: { value: "whisper-1" } });
    fireEvent.change(screen.getByLabelText("Refine timeout ms"), { target: { value: "12000" } });
    fireEvent.change(screen.getByLabelText("Pre-roll ms"), { target: { value: "800" } });
    fireEvent.change(screen.getByLabelText("Post-roll ms"), { target: { value: "1300" } });
    fireEvent.change(screen.getByLabelText("Max burst ms"), { target: { value: "9000" } });
    fireEvent.change(screen.getByLabelText("WAV retention ttl ms"), { target: { value: "3600000" } });
    fireEvent.change(screen.getByLabelText("WAV max files"), { target: { value: "7" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /apply audio config/i }));
    });

    expect(AmbientAi.audio.configure).toHaveBeenCalledWith({
      cloudMode: "devDirect",
      recognitionLocale: "zh-CN",
      cloudApiKey: "sk-dev",
      modelName: "whisper-1",
      cloudRefineTimeoutMs: 12000,
      preRollMs: 800,
      postRollMs: 1300,
      maxBurstMs: 9000,
      wavRetentionTtlMs: 3600000,
      wavMaxFiles: 7,
    });
    expect(await screen.findByText("Config applied")).toBeTruthy();
  });

  test("keeps numeric fields editable while empty", () => {
    render(<AmbientAudioDebugPanel />);

    const postRollInput = screen.getByLabelText("Post-roll ms") as HTMLInputElement;

    fireEvent.change(postRollInput, { target: { value: "" } });
    expect(postRollInput.value).toBe("");

    fireEvent.change(postRollInput, { target: { value: "10000" } });
    expect(postRollInput.value).toBe("10000");
  });

  test("persists applied audio config fields and restores them on remount", async () => {
    const { unmount } = render(<AmbientAudioDebugPanel />);

    fireEvent.change(screen.getByLabelText("Cloud API key"), { target: { value: "sk-dev" } });
    fireEvent.change(screen.getByLabelText("Post-roll ms"), { target: { value: "10000" } });
    fireEvent.change(screen.getByLabelText("Max burst ms"), { target: { value: "30000" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /apply audio config/i }));
    });

    unmount();
    render(<AmbientAudioDebugPanel />);

    expect((screen.getByLabelText("Post-roll ms") as HTMLInputElement).value).toBe("10000");
    expect((screen.getByLabelText("Max burst ms") as HTMLInputElement).value).toBe("30000");
    expect((screen.getByLabelText("Cloud API key") as HTMLInputElement).value).toBe("");

    await waitFor(() => {
      expect(AmbientAi.audio.configure).toHaveBeenLastCalledWith(expect.objectContaining({
        postRollMs: 10000,
        maxBurstMs: 30000,
      }));
    });
  });

  test("refreshes state, lists captures, controls playback, and drains transcripts", async () => {
    render(<AmbientAudioDebugPanel />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /refresh state/i }));
      fireEvent.click(screen.getByRole("button", { name: /refresh captures/i }));
    });

    expect(await screen.findByText(/running: true/i)).toBeTruthy();
    expect(await screen.findByText("wav-1")).toBeTruthy();
    expect(screen.getByText(/1\.5s/)).toBeTruthy();
    expect(screen.getByText(/48\.0 KB/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /play wav-1/i }));
    });
    expect(AmbientAi.audio.playCapture).toHaveBeenCalledWith({ wavId: "wav-1" });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /stop playback/i }));
    });
    expect(AmbientAi.audio.stopPlayback).toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /drain pending transcripts/i }));
    });
    expect(await screen.findByText(/drained transcript text/i)).toBeTruthy();
  });

  test("previews recent audio events from AmbientAi listeners", async () => {
    render(<AmbientAudioDebugPanel />);

    await waitFor(() => {
      expect(AmbientAi.addListener).toHaveBeenCalledWith("audioState", expect.any(Function));
      expect(AmbientAi.addListener).toHaveBeenCalledWith("speechBurst", expect.any(Function));
      expect(AmbientAi.addListener).toHaveBeenCalledWith("transcriptDraft", expect.any(Function));
      expect(AmbientAi.addListener).toHaveBeenCalledWith("transcriptRefined", expect.any(Function));
      expect(AmbientAi.addListener).toHaveBeenCalledWith("transcriptReady", expect.any(Function));
      expect(AmbientAi.addListener).toHaveBeenCalledWith("audioError", expect.any(Function));
    });

    act(() => {
      mockControls.emitAmbientAudioTestEvent("transcriptReady", {
        platform: "ios",
        wavId: "wav-event",
        burstId: "burst-event",
        captureSessionId: "session-event",
        text: "ready transcript preview",
        capturedAt: "2026-05-10T11:00:00.000Z",
        durationMs: 3200,
        provider: "cloud_whisper",
        fallback: false,
        transcriptLocale: "zh-CN",
      });
      mockControls.emitAmbientAudioTestEvent("audioError", {
        source: "cloud",
        message: "refine timeout",
      });
    });

    expect(await screen.findByText("transcriptReady")).toBeTruthy();
    expect(screen.getAllByText(/ready transcript preview/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/zh-CN/i).length).toBeGreaterThan(0);
    expect(screen.getByText("audioError")).toBeTruthy();
    expect(screen.getByText(/cloud: refine timeout/i)).toBeTruthy();
  });


  test("shows speech gate classification state with current default rule", async () => {
    render(<AmbientAudioDebugPanel />);

    await waitFor(() => {
      expect(AmbientAi.addListener).toHaveBeenCalledWith("soundClassification", expect.any(Function));
    });

    act(() => {
      mockControls.emitAmbientAudioTestEvent("soundClassification", {
        timestamp: 1778419887054,
        classifications: [
          { label: "speech", confidence: 0.8977 },
          { label: "music", confidence: 0.3572 },
          { label: "keyboard_musical", confidence: 0.1612 },
        ],
      });
    });

    expect(await screen.findByText("Speech gate")).toBeTruthy();
    expect(screen.getByText("speech >= 60% · 1 frame")).toBeTruthy();
    expect(screen.getByText("speech 90%")).toBeTruthy();
    expect(screen.getByText("music 36%")).toBeTruthy();
    expect(screen.getByText("1 / 1")).toBeTruthy();
  });

  test("tracks recording sessions and empty transcript results", async () => {
    render(<AmbientAudioDebugPanel />);

    act(() => {
      mockControls.emitAmbientAudioTestEvent("speechBurst", {
        confidence: 0.8977,
        durationMs: 0,
        timestamp: 1778419887054,
      });
      mockControls.emitAmbientAudioTestEvent("transcriptDraft", {
        platform: "ios",
        wavId: "wav-empty",
        burstId: "burst-empty",
        captureSessionId: "session-empty",
        text: "",
        capturedAt: "2026-05-10T13:31:28.354Z",
        durationMs: 1690,
      });
      mockControls.emitAmbientAudioTestEvent("transcriptReady", {
        platform: "ios",
        wavId: "wav-empty",
        burstId: "burst-empty",
        captureSessionId: "session-empty",
        text: "",
        capturedAt: "2026-05-10T13:31:28.354Z",
        durationMs: 1690,
        provider: "local_speech",
        fallback: false,
        localProvider: "sfspeech",
        segmentIndex: 1,
      });
    });

    expect(await screen.findByText("Recording session")).toBeTruthy();
    expect(screen.getByText("empty")).toBeTruthy();
    expect(screen.getAllByText(/wav-empty/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/local_speech/).length).toBeGreaterThan(0);
    expect(screen.getByText("Recent recording runs")).toBeTruthy();
    expect(screen.getByText("No recording runs yet")).toBeTruthy();
  });


  test("does not reuse speech confidence after a completed run", async () => {
    render(<AmbientAudioDebugPanel />);

    act(() => {
      mockControls.emitAmbientAudioTestEvent("speechBurst", {
        confidence: 0.91,
        durationMs: 0,
        timestamp: 1778419887054,
      });
      mockControls.emitAmbientAudioTestEvent("transcriptReady", {
        platform: "ios",
        wavId: "wav-first",
        burstId: "burst-first",
        captureSessionId: "session-first",
        text: "first transcript text",
        capturedAt: "2026-05-10T13:31:28.354Z",
        durationMs: 1690,
        provider: "local_speech",
        fallback: false,
      });
      mockControls.emitAmbientAudioTestEvent("transcriptReady", {
        platform: "ios",
        wavId: "wav-second",
        burstId: "burst-second",
        captureSessionId: "session-second",
        text: "second transcript text",
        capturedAt: "2026-05-10T13:31:30.354Z",
        durationMs: 1200,
        provider: "local_speech",
        fallback: false,
      });
    });

    expect((await screen.findAllByText("wav-second")).length).toBeGreaterThan(0);
    expect(screen.getByText(/speech 91%/)).toBeTruthy();
    expect(screen.getAllByText(/speech 91%/).length).toBe(1);
  });

  test("shows concise background and WAV validation prep notes", () => {
    render(<AmbientAudioDebugPanel />);

    expect(screen.getByText(/Background\/WAV validation prep/i)).toBeTruthy();
    expect(screen.getByText(/Test with screen locked and app backgrounded/i)).toBeTruthy();
    expect(screen.getByText(/Verify listed WAV duration and bytes before playback/i)).toBeTruthy();
  });
});
