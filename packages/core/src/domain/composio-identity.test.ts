import { describe, expect, test } from "vitest";

import {
  extractComposioDisplayIdentity,
  formatComposioConnectionIdentity,
  formatComposioToolkitName,
  formatOptionalComposioConnectionIdentity,
  resolveComposioConnectionIdentity,
  type ComposioIdentityConnection,
} from "./composio-identity";

describe("composio display identity", () => {
  test("extracts Gmail profile emailAddress", () => {
    expect(
      extractComposioDisplayIdentity({
        emailAddress: "sam@example.com",
        historyId: "833407",
      }),
    ).toBe("sam@example.com");
  });

  test("reuses Gmail identity for Google-family connectors with empty userInfo", () => {
    const connections: ComposioIdentityConnection[] = [
      {
        toolkit: "gmail",
        status: "ACTIVE",
        connectedAccountId: "gmail-1",
        userInfo: { emailAddress: "sam@example.com" },
      },
      {
        toolkit: "googlecalendar",
        status: "ACTIVE",
        connectedAccountId: "gcal-1",
        userInfo: null,
      },
    ];

    expect(resolveComposioConnectionIdentity(connections[1]!, connections)).toBe("sam@example.com");
  });

  test("does not expose connected account ids as fallback identity", () => {
    expect(
      formatComposioConnectionIdentity(
        {
          toolkit: "zoom",
          status: "ACTIVE",
          connectedAccountId: "ca_E__73kQVgI0v",
          userInfo: null,
        },
        [],
      ),
    ).toBe("Account details unavailable");
  });

  test("optional identity returns null for unavailable account details", () => {
    expect(
      formatOptionalComposioConnectionIdentity(
        {
          toolkit: "zoom",
          status: "ACTIVE",
          connectedAccountId: "ca_E__73kQVgI0v",
          userInfo: null,
        },
        [],
      ),
    ).toBeNull();
  });

  test("formats toolkit slugs as readable connector names", () => {
    expect(formatComposioToolkitName("googlecalendar")).toBe("Google Calendar");
    expect(formatComposioToolkitName("custom_toolkit")).toBe("Custom Toolkit");
  });
});
