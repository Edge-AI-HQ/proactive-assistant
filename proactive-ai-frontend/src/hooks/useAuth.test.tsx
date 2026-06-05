import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { useAuth } from "./useAuth";

const { onAuthStateChangeMock, signInWithOAuthMock } = vi.hoisted(() => ({
  onAuthStateChangeMock: vi.fn(),
  signInWithOAuthMock: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      onAuthStateChange: onAuthStateChangeMock,
      signInWithOAuth: signInWithOAuthMock,
      signOut: vi.fn(),
      exchangeCodeForSession: vi.fn(),
    },
  },
}));

vi.mock("@/lib/platform", () => ({ isNative: false }));
vi.mock("@/lib/devices", () => ({ clearDeviceCredentials: vi.fn() }));
vi.mock("@capacitor/browser", () => ({ Browser: { open: vi.fn(), close: vi.fn() } }));
vi.mock("@capacitor/app", () => ({ App: { addListener: vi.fn() } }));

describe("useAuth local dev auth", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_PIN_LOCAL_DEV_AUTH", "");
    onAuthStateChangeMock.mockReset();
    signInWithOAuthMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("returns the fixed local user without subscribing to Supabase", () => {
    vi.stubEnv("VITE_PIN_LOCAL_DEV_AUTH", "1");

    const { result } = renderHook(() => useAuth());

    expect(result.current.loading).toBe(false);
    expect(result.current.user?.id).toBe("00000000-0000-0000-0000-00000000d0d0");
    expect(result.current.user?.email).toBe("dev-user@local.invalid");
    expect(onAuthStateChangeMock).not.toHaveBeenCalled();
  });

  test("uses Supabase auth when local dev auth is off", () => {
    onAuthStateChangeMock.mockReturnValue({
      data: { subscription: { unsubscribe: vi.fn() } },
    });

    renderHook(() => useAuth());

    expect(onAuthStateChangeMock).toHaveBeenCalledTimes(1);
  });
});
