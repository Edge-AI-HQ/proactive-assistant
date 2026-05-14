import { describe, expect, it } from "vitest";
import { oauthRedirectOriginFromHref } from "./redirect";

describe("oauth redirect url", () => {
  it("normalizes local loopback hosts to localhost:3004", () => {
    expect(oauthRedirectOriginFromHref("http://127.0.0.1:3004/runs")).toBe("http://localhost:3004/");
    expect(oauthRedirectOriginFromHref("http://localhost:3004/runs")).toBe("http://localhost:3004/");
    expect(oauthRedirectOriginFromHref("http://127.0.0.1/runs")).toBe("http://localhost:3004/");
  });

  it("keeps deployed origins unchanged", () => {
    expect(oauthRedirectOriginFromHref("https://dashboard.example.com/runs")).toBe("https://dashboard.example.com/");
  });
});
