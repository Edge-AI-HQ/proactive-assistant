import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import App from "./App";
import { setPersistedAmbientEnabled } from "@/services/ambient/enabled-state";
import { ALL_SOURCE_KEYS } from "@/services/ambient/keys";

const { startAmbientUploadMock, useUserSettingsMock } = vi.hoisted(() => ({
  startAmbientUploadMock: vi.fn(),
  useUserSettingsMock: vi.fn(),
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

  test("restarts all ambient sources with the loaded language when the local ambient switch is persisted on", async () => {
    setPersistedAmbientEnabled(true);
    useUserSettingsMock.mockReturnValue({
      settings: {
        generationLanguage: "zh-Hans",
        ambientSources: {},
      },
    });

    render(<App />);

    await waitFor(() => {
      expect(startAmbientUploadMock).toHaveBeenCalledWith({
        enabledSources: ALL_SOURCE_KEYS,
        transcriptionLanguage: "zh-Hans",
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
