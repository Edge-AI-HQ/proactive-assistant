import { describe, expect, test } from "vitest";

import {
  composioToolkitCovers,
  getComposioConnectionsForToolkit,
  isComposioToolkitConnected,
  normalizeComposioToolkit,
  type ComposioConnection,
} from "./composio";

const googleWorkspace: ComposioConnection = {
  toolkit: "googlesuper",
  status: "ACTIVE",
  connectedAccountId: "google-workspace-account",
  label: "user@example.com",
  userInfo: null,
};

describe("Composio toolkit fanout", () => {
  test("normalizes prompt-friendly toolkit names", () => {
    expect(normalizeComposioToolkit("google_calendar")).toBe("googlecalendar");
    expect(normalizeComposioToolkit("Google Drive")).toBe("googledrive");
  });

  test("treats googlesuper as covering Google sub-toolkits", () => {
    expect(composioToolkitCovers("googlesuper", "gmail")).toBe(true);
    expect(composioToolkitCovers("googlesuper", "googlecalendar")).toBe(true);
    expect(composioToolkitCovers("googlesuper", "googledrive")).toBe(true);
    expect(composioToolkitCovers("googlesuper", "googledocs")).toBe(true);
    expect(composioToolkitCovers("googlesuper", "googlesheets")).toBe(true);
    expect(composioToolkitCovers("googlesuper", "github")).toBe(false);
  });

  test("does not treat a sub-toolkit as the aggregate toolkit", () => {
    expect(composioToolkitCovers("gmail", "googlesuper")).toBe(false);
  });

  test("returns aggregate accounts for Google sub-toolkits", () => {
    const connections = [
      googleWorkspace,
      { ...googleWorkspace, toolkit: "slack", connectedAccountId: "slack-account" },
    ];

    expect(isComposioToolkitConnected(connections, "gmail")).toBe(true);
    expect(getComposioConnectionsForToolkit(connections, "gmail")).toEqual([googleWorkspace]);
  });
});
