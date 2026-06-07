import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const voiceApiMock = vi.hoisted(() => ({
  fetchVoiceIdentity: vi.fn(),
  uploadVoiceIdentityReference: vi.fn(),
  setVoiceIdentityEnabled: vi.fn(),
  deleteVoiceIdentityReference: vi.fn(),
}));
const recorderMock = vi.hoisted(() => ({
  createPcmRecorder: vi.fn(),
}));
const userSettingsMock = vi.hoisted(() => ({
  useUserSettings: vi.fn(),
}));

vi.mock("@/services/voiceIdentityApi", () => voiceApiMock);
vi.mock("@/components/voice/pcmRecorder", () => recorderMock);
vi.mock("@/hooks/useUserSettings", () => userSettingsMock);

describe("VoiceIdentitySettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    userSettingsMock.useUserSettings.mockReturnValue({
      settings: { generationLanguage: "en" },
      loading: false,
      saving: false,
      error: null,
      patch: vi.fn(),
    });
    voiceApiMock.fetchVoiceIdentity.mockResolvedValue(null);
    voiceApiMock.uploadVoiceIdentityReference.mockResolvedValue({
      enabled: true,
      speakerName: "self",
      enrolledAt: "2026-05-27T00:00:00Z",
      updatedAt: "2026-05-27T00:00:00Z",
      referenceDurationMs: 5000,
      referenceByteLen: 32000,
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [] })),
      },
    });
    recorderMock.createPcmRecorder.mockResolvedValue({
      stop: vi.fn(async () => new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" })),
    });
  });

  test("shows an English daily read-aloud prompt without product naming", async () => {
    const { default: VoiceIdentitySettings } = await import("@/components/account/VoiceIdentitySettings");
    render(<VoiceIdentitySettings />);

    expect(await screen.findByText(/This morning I checked my schedule/i)).toBeTruthy();
    expect(screen.queryByText(/PIN AI/i)).toBeNull();
  });

  test("keeps the enrollment status on one line", async () => {
    const { default: VoiceIdentitySettings } = await import("@/components/account/VoiceIdentitySettings");
    render(<VoiceIdentitySettings />);

    const status = await screen.findByText("Not enrolled");
    expect(status.className).toContain("whitespace-nowrap");
  });

  test("shows a Chinese daily read-aloud prompt for Chinese language settings", async () => {
    userSettingsMock.useUserSettings.mockReturnValue({
      settings: { generationLanguage: "zh-Hans" },
      loading: false,
      saving: false,
      error: null,
      patch: vi.fn(),
    });

    const { default: VoiceIdentitySettings } = await import("@/components/account/VoiceIdentitySettings");
    render(<VoiceIdentitySettings />);

    expect(await screen.findByText(/今天早上我整理了日程/)).toBeTruthy();
    expect(screen.queryByText(/PIN AI/i)).toBeNull();
  });

  test("renders no-profile state and rejects saving a short sample", async () => {
    const { default: VoiceIdentitySettings } = await import("@/components/account/VoiceIdentitySettings");
    render(<VoiceIdentitySettings />);

    expect(await screen.findByText("Voice identity")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Record self reference/i }));
    await screen.findByText(/Recording/);
    fireEvent.click(screen.getByRole("button", { name: /Stop/i }));

    await screen.findByRole("button", { name: /Save reference/i });
    expect(screen.getByText(/Record at least 2 seconds/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Save reference/i }).hasAttribute("disabled")).toBe(true);
  });

  test("saves a reviewed sample and shows enrolled state", async () => {
    const dateNow = vi.spyOn(Date, "now");
    let now = 1_000;
    dateNow.mockImplementation(() => now);
    const { default: VoiceIdentitySettings } = await import("@/components/account/VoiceIdentitySettings");
    render(<VoiceIdentitySettings />);

    fireEvent.click(await screen.findByRole("button", { name: /Record self reference/i }));
    const stopButton = await screen.findByRole("button", { name: /Stop/i });
    now = 6_000;
    fireEvent.click(stopButton);
    await screen.findByRole("button", { name: /Save reference/i });
    fireEvent.click(screen.getByRole("button", { name: /Save reference/i }));

    await waitFor(() => {
      expect(voiceApiMock.uploadVoiceIdentityReference).toHaveBeenCalledWith(
        expect.any(Blob),
        expect.any(Number),
      );
      expect(screen.getByText(/Enrolled/)).toBeTruthy();
    });
    dateNow.mockRestore();
  });

  test("renders enrolled disabled state and can enable it", async () => {
    voiceApiMock.fetchVoiceIdentity.mockResolvedValue({
      enabled: false,
      speakerName: "self",
      enrolledAt: "2026-05-27T00:00:00Z",
      updatedAt: "2026-05-27T00:00:00Z",
      referenceDurationMs: 5000,
      referenceByteLen: 32000,
    });
    voiceApiMock.setVoiceIdentityEnabled.mockResolvedValue({
      enabled: true,
      speakerName: "self",
      enrolledAt: "2026-05-27T00:00:00Z",
      updatedAt: "2026-05-27T00:00:00Z",
      referenceDurationMs: 5000,
      referenceByteLen: 32000,
    });

    const { default: VoiceIdentitySettings } = await import("@/components/account/VoiceIdentitySettings");
    render(<VoiceIdentitySettings />);

    fireEvent.click(await screen.findByRole("button", { name: /Enable voice identity/i }));
    await waitFor(() => {
      expect(voiceApiMock.setVoiceIdentityEnabled).toHaveBeenCalledWith(true);
    });
  });
});
