import { describe, expect, it } from "vitest";
import { extractIdentity } from "./provider.js";

describe("extractIdentity", () => {
  it("prefers email over Supabase issuer noise", () => {
    const out = extractIdentity({
      iss: "https://qgqjgrmpphyojzldatyb.supabase.co/auth/v1",
      aud: "authenticated",
      email: "user@gmail.com",
      domain: "qgqjgrmpphyojzldatyb.supabase.co",
    });
    expect(out).toBe("user@gmail.com");
  });

  it("ignores bare supabase host and OIDC keys in fallback scan", () => {
    const out = extractIdentity({
      iss: "https://example.com",
      sub: "uuid-like-not-used",
      domain: "qgqjgrmpphyojzldatyb.supabase.co",
      displayName: "Alex",
    });
    expect(out).toBe("Alex");
  });

  it("returns null when only noise strings remain", () => {
    const out = extractIdentity({
      iss: "https://qgqjgrmpphyojzldatyb.supabase.co/auth/v1",
      aud: "anon",
    });
    expect(out).toBeNull();
  });
});
