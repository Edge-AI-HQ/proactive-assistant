import { describe, expect, it } from "vitest";
import { demoSourceRows } from "./PatternDetailView";
import { redactedSecretText } from "@/lib/redaction";

describe("PatternDetailView demo source helpers", () => {
  it("redacts sensitive sourceData preview fields before rendering", () => {
    const rows = demoSourceRows({
      sourceData: [
        {
          label: "Gmail",
          mock: {
            subject: "Receipt",
            accessToken: "secret-access-token",
            headers: [{ name: "Authorization", value: "Bearer secret-token" }],
          },
        },
      ],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe("Gmail");
    expect(rows[0].preview).toContain("Receipt");
    expect(rows[0].preview).toContain(redactedSecretText);
    expect(rows[0].preview).not.toContain("secret-access-token");
    expect(rows[0].preview).not.toContain("secret-token");
  });
});
