// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { signOutMock, runSignOutCleanupsMock, isPinLocalDevAuthEnabledMock } =
  vi.hoisted(() => ({
    signOutMock: vi.fn(),
    runSignOutCleanupsMock: vi.fn(),
    isPinLocalDevAuthEnabledMock: vi.fn(),
  }));

vi.mock("./supabase", () => ({ supabase: { auth: { signOut: signOutMock } } }));
vi.mock("./auth-cleanup", () => ({ runSignOutCleanups: runSignOutCleanupsMock }));
vi.mock("./dev-auth", () => ({
  isPinLocalDevAuthEnabled: isPinLocalDevAuthEnabledMock,
}));

let reloadMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // performSignOut keeps a module-level idempotency latch — reset modules so
  // each test imports a fresh, un-latched copy.
  vi.resetModules();
  signOutMock.mockReset().mockResolvedValue({ error: null });
  runSignOutCleanupsMock.mockReset().mockResolvedValue(undefined);
  isPinLocalDevAuthEnabledMock.mockReset().mockReturnValue(false);
  localStorage.clear();
  sessionStorage.clear();
  reloadMock = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { reload: reloadMock },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("performSignOut", () => {
  test("clears our keys + the supabase session key, keeps unrelated ones", async () => {
    localStorage.setItem("pinai:thread", "x");
    localStorage.setItem("sb-proj-auth-token", "y");
    localStorage.setItem("unrelated", "keep");
    sessionStorage.setItem("proactive-ai:foo", "x");
    sessionStorage.setItem("other", "keep");

    const { performSignOut } = await import("./sign-out");
    await performSignOut();

    expect(localStorage.getItem("pinai:thread")).toBeNull();
    expect(localStorage.getItem("sb-proj-auth-token")).toBeNull();
    expect(localStorage.getItem("unrelated")).toBe("keep");
    expect(sessionStorage.getItem("proactive-ai:foo")).toBeNull();
    expect(sessionStorage.getItem("other")).toBe("keep");
    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  test("still reloads when supabase.signOut rejects (stale token)", async () => {
    signOutMock.mockRejectedValue(new Error("Auth session missing"));

    const { performSignOut } = await import("./sign-out");
    await performSignOut();

    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  test("is idempotent — concurrent invocations reload exactly once", async () => {
    const { performSignOut } = await import("./sign-out");
    await Promise.all([performSignOut(), performSignOut(), performSignOut()]);

    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  test("skips supabase.signOut under local dev auth but still reloads", async () => {
    isPinLocalDevAuthEnabledMock.mockReturnValue(true);

    const { performSignOut } = await import("./sign-out");
    await performSignOut();

    expect(signOutMock).not.toHaveBeenCalled();
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });
});
