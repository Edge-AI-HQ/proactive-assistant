import { describe, expect, it } from "vitest";
import { isSensitiveKey, redactSensitivePayload, redactedJsonString, redactedSecretText, redactSensitiveText } from "./redaction";

describe("redaction helpers", () => {
  it("detects common secret-like keys across casing styles", () => {
    expect(isSensitiveKey("accessToken")).toBe(true);
    expect(isSensitiveKey("refresh_token")).toBe(true);
    expect(isSensitiveKey("client-secret")).toBe(true);
    expect(isSensitiveKey("authorization")).toBe(true);
    expect(isSensitiveKey("displayName")).toBe(false);
  });

  it("recursively redacts secret-like keys", () => {
    const payload = redactSensitivePayload({
      publicLabel: "keep me",
      accessToken: "secret-token",
      nested: [{ refresh_token: "refresh-secret", value: "visible" }],
    });

    expect(payload).toEqual({
      publicLabel: "keep me",
      accessToken: redactedSecretText,
      nested: [{ refresh_token: redactedSecretText, value: "visible" }],
    });
  });

  it("redacts value fields when a sibling name points at a secret", () => {
    const payload = redactSensitivePayload({
      headers: [
        { name: "Authorization", value: "Bearer secret-token" },
        { name: "X-Public-Label", value: "visible label" },
      ],
    });

    expect(payload).toEqual({
      headers: [
        { name: "Authorization", value: redactedSecretText },
        { name: "X-Public-Label", value: "visible label" },
      ],
    });
  });

  it("keeps debug JSON from leaking redacted values", () => {
    const json = redactedJsonString({
      title: "trace",
      apiKey: "secret-api-key",
      rawHeaders: [{ header: "cookie", raw_value: "secret-cookie" }],
    });

    expect(json).toContain(redactedSecretText);
    expect(json).toContain("trace");
    expect(json).not.toContain("secret-api-key");
    expect(json).not.toContain("secret-cookie");
  });

  it("redacts secret-looking key-value pairs inside exported text", () => {
    const text = redactSensitiveText(
      "Authorization: Bearer secret-access-token; api_key=secret-api-key; visible label",
    );

    expect(text).toContain(redactedSecretText);
    expect(text).toContain("visible label");
    expect(text).not.toContain("secret-access-token");
    expect(text).not.toContain("secret-api-key");
  });

  it("redacts secret-looking URL query params inside exported text", () => {
    const text = redactSensitiveText("https://example.com/callback?access_token=secret-token&state=visible");

    expect(text).toContain(`access_token=${redactedSecretText}`);
    expect(text).toContain("state=visible");
    expect(text).not.toContain("secret-token");
  });

  it("redacts JSON object strings before exporting text", () => {
    const text = redactSensitiveText(JSON.stringify({
      label: "visible",
      refresh_token: "secret-refresh-token",
    }));

    expect(text).toContain("visible");
    expect(text).toContain(redactedSecretText);
    expect(text).not.toContain("secret-refresh-token");
  });
});
