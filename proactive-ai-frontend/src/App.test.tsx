import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import App from "./App";
import { setPersistedAmbientEnabled } from "@/services/ambient/enabled-state";

const { startAmbientUploadMock, useUserSettingsMock } = vi.hoisted(() => ({
  startAmbientUploadMock: vi.fn(),
  useUserSettingsMock: vi.fn(),
}));

vi.mock("@/services/ambient", () => ({
  getAmbientRuntime: () => ({
    status: () => ({ uploadsLocked: false }),
    subscribe: () => () => {},
  }),
}));
vi.mock("@/lib/api", () => ({
  summarizeAmbientWithCloud: vi.fn(),
}));
vi.mock("@/lib/platform", () => ({ isNative: true }));
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    loading: false,
    user: { id: "user-1" },
    signInWithGoogle: vi.fn(),
  }),
}));
vi.mock("@/hooks/useUserSettings", () => ({
  useUserSettings: () => useUserSettingsMock(),
}));
vi.mock("@/components/LoginPage", () => ({
  default: () => <div>Login</div>,
}));
vi.mock("@/components/constellation/ConstellationLayout", () => ({
  default: () => <div>Constellation</div>,
}));
vi.mock("@/services/ambient/lifecycle", () => ({
  startAmbientUpload: startAmbientUploadMock,
}));

describe("App ambient boot", () => {
  afterEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  test("waits for settings before using the persisted ambient switch", async () => {
    setPersistedAmbientEnabled(true);
    useUserSettingsMock.mockReturnValue({ settings: null });

    render(<App />);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(startAmbientUploadMock).not.toHaveBeenCalled();
  });

  test("starts only the server-consented sources when this device has opted in locally", async () => {
    setPersistedAmbientEnabled(true);
    useUserSettingsMock.mockReturnValue({
      settings: {
        generationLanguage: "zh-Hans",
        ambientSources: {
          location: { enabled: true },
          visit: { enabled: false },
        },
      },
    });

    render(<App />);

    await waitFor(() => {
      expect(startAmbientUploadMock).toHaveBeenCalledWith({
        enabledSources: ["location"],
        transcriptionLanguage: "zh-Hans",
      });
    });
  });

  test("does not start ambient on a device with no local opt-in even when the server still consents", async () => {
    // Reinstall / new device: localStorage was cleared but the server still
    // remembers the user's ambient consent. The per-device gate must keep
    // sources off until the user re-opts-in on this device, so the boot
    // effect reconciles to an empty set instead of restoring the consent.
    useUserSettingsMock.mockReturnValue({
      settings: {
        generationLanguage: "en-US",
        ambientSources: { location: { enabled: true } },
      },
    });

    render(<App />);

    await waitFor(() => {
      expect(startAmbientUploadMock).toHaveBeenCalledWith({
        enabledSources: [],
        transcriptionLanguage: "en-US",
      });
    });
  });

  test("does not start ambient sources before settings load when no local enablement exists", async () => {
    useUserSettingsMock.mockReturnValue({ settings: null });

    render(<App />);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(startAmbientUploadMock).not.toHaveBeenCalled();
  });
});
