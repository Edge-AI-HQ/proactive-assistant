import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, test, vi } from "vitest";

import App from "./App";

const { useAuthMock } = vi.hoisted(() => ({ useAuthMock: vi.fn() }));

// 只替换 useAuth；其余（CATEGORIES / hooks / Sphere3DCards …）用真实实现，
// 数据 hooks 在 jsdom 里 fetch 失败会落到 TQ error 态，渲染层不受影响。
vi.mock("@pin-ai/ui-web", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAuth: useAuthMock,
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

    renderApp();

    expect(screen.getByText("Continue with Google")).toBeTruthy();
  });

  test("shows the zebra shell nav when signed in", () => {
    useAuthMock.mockReturnValue({
      loading: false,
      session: {},
      user: { email: "dev@pinai.io", user_metadata: { full_name: "Dev User" } },
      signInWithGoogle: vi.fn(),
      signOut: vi.fn(),
    });

    renderApp();

    // NOW 同时出现在 nav 与视图问候里，用 getAllByText 断言存在性。
    for (const label of ["NOW", "AMBIENT", "TASKS", "CONNECT", "MIRROR", "SETTING"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.getAllByText(/Dev User/).length).toBeGreaterThan(0);
  });
});
