import { describe, expect, test } from "vitest";

import {
  canonicalConnectorSlugFromIntentKey,
  connectorSlugFromIntentKey,
  isConnectorCard,
} from "./connector-card";

describe("connector card slug helpers", () => {
  test("isConnectorCard 认 connect: 前缀", () => {
    expect(isConnectorCard({ intentKey: "connect:gmail" })).toBe(true);
    expect(isConnectorCard({ intentKey: "other" })).toBe(false);
    expect(isConnectorCard({ intentKey: undefined })).toBe(false);
  });

  test("connectorSlugFromIntentKey 提取 slug", () => {
    expect(connectorSlugFromIntentKey("connect:google_calendar")).toBe("google_calendar");
    expect(connectorSlugFromIntentKey("nope")).toBeNull();
    expect(connectorSlugFromIntentKey(undefined)).toBeNull();
  });

  test("canonicalConnectorSlugFromIntentKey 经 resolveToolkit 归一", () => {
    expect(canonicalConnectorSlugFromIntentKey("connect:google_calendar")).toBe("googlecalendar");
    expect(canonicalConnectorSlugFromIntentKey("connect:gmail")).toBe("gmail");
    expect(canonicalConnectorSlugFromIntentKey("connect:unknown")).toBeNull();
  });
});
