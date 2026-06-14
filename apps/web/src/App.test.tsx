import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, test, vi } from "vitest";

import App from "./App";

const { useAuthMock, useUserSettingsMock } = vi.hoisted(() => ({
  useAuthMock: vi.fn(),
  useUserSettingsMock: vi.fn(),
}));

// 只替换 useAuth；其余（CATEGORIES / hooks / Sphere3DCards …）用真实实现，
// 数据 hooks 在 jsdom 里 fetch 失败会落到 TQ error 态，渲染层不受影响。
vi.mock("@pin-ai/ui-web", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAuth: useAuthMock,
}));
// useUserSettings gate 着已登录 UI（onboarding 判定）——mock 它以脱离网络；
// 其余 @pin-ai/state hooks（useComposio / useCardsQuery …）保留真实。
vi.mock("@pin-ai/state", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useUserSettings: () => useUserSettingsMock(),
}));

function renderApp() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

describe("App auth gate", () => {
  test("shows the zebra login when signed out", () => {
    useAuthMock.mockReturnValue({
      loading: false,
      session: null,
      user: null,
      signInWithGoogle: vi.fn(),
      signOut: vi.fn(),
    });
    useUserSettingsMock.mockReturnValue({
      settings: null,
      loading: false,
      patch: vi.fn(),
      refetch: vi.fn(),
    });

    renderApp();

    expect(screen.getByText("Continue with Google")).toBeTruthy();
  });

  test("shows onboarding when signed in before onboarding is done", () => {
    useAuthMock.mockReturnValue({
      loading: false,
      session: {},
      user: { email: "dev@pinai.io", user_metadata: { full_name: "Dev User" } },
      signInWithGoogle: vi.fn(),
      signOut: vi.fn(),
    });
    useUserSettingsMock.mockReturnValue({
      settings: { onboardingCompletedAt: null, ambientSources: {} },
      loading: false,
      patch: vi.fn(),
      refetch: vi.fn(),
    });

    renderApp();

    expect(screen.getByText("Connect your data")).toBeTruthy();
    expect(screen.getByText("Enter PIN AI")).toBeTruthy();
  });

  test("shows the zebra shell nav when signed in and onboarded", () => {
    useAuthMock.mockReturnValue({
      loading: false,
      session: {},
      user: { email: "dev@pinai.io", user_metadata: { full_name: "Dev User" } },
      signInWithGoogle: vi.fn(),
      signOut: vi.fn(),
    });
    useUserSettingsMock.mockReturnValue({
      settings: { onboardingCompletedAt: "2026-06-14T00:00:00Z", ambientSources: {} },
      loading: false,
      patch: vi.fn(),
      refetch: vi.fn(),
    });

    renderApp();

    // NOW 同时出现在 nav 与视图问候里，用 getAllByText 断言存在性。
    for (const label of ["NOW", "AMBIENT", "TASKS", "CONNECT", "MIRROR", "SETTING"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.getAllByText(/Dev User/).length).toBeGreaterThan(0);
  });
});
