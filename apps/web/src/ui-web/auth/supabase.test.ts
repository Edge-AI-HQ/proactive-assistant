// @vitest-environment jsdom
import { describe, expect, test, vi } from "vitest";

// supabase.ts imports ./platform (Capacitor) at module load; stub it so the
// import chain stays in the web branch under jsdom. createClient runs with the
// fake VITE_SUPABASE_* from vitest.config; captureInitialOAuthError reads the
// (clean) jsdom location, so initialOAuthError is null here — we test the pure
// parser directly.
vi.mock("./platform", () => ({ isNative: false, isElectron: false }));

import { parseOAuthError } from "./supabase";

describe("parseOAuthError", () => {
  test("reads error_description from the hash fragment (implicit flow)", () => {
    expect(
      parseOAuthError(
        "#error=access_denied&error_description=User+did+not+approve",
        "",
      ),
    ).toBe("User did not approve");
  });

  test("reads the error from the query string (fallback)", () => {
    expect(parseOAuthError("", "?error=server_error")).toBe("server_error");
  });

  test("prefers error_description over the bare error code", () => {
    expect(
      parseOAuthError("#error=access_denied&error_description=Not+a+test+user", ""),
    ).toBe("Not a test user");
  });

  test("returns null on a clean or success URL", () => {
    expect(parseOAuthError("", "")).toBeNull();
    expect(parseOAuthError("#access_token=abc&token_type=bearer", "")).toBeNull();
  });
});
