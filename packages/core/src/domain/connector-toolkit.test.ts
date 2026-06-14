import { describe, expect, test } from "vitest";

import { resolveToolkit } from "./connector-toolkit";

describe("resolveToolkit", () => {
  test("canonical slug 命中(canonicalSlug + label + iconKey)", () => {
    expect(resolveToolkit("gmail")).toEqual({ canonicalSlug: "gmail", label: "Gmail", iconKey: "mail" });
  });

  test("下划线友好别名归一到 canonical", () => {
    expect(resolveToolkit("google_calendar")?.canonicalSlug).toBe("googlecalendar");
    expect(resolveToolkit("gcal")?.canonicalSlug).toBe("googlecalendar");
    expect(resolveToolkit("gdrive")?.canonicalSlug).toBe("googledrive");
  });

  test("大小写 + 空白容错", () => {
    expect(resolveToolkit("  GMAIL ")?.canonicalSlug).toBe("gmail");
  });

  test("未知 / 空 → null", () => {
    expect(resolveToolkit("nope")).toBeNull();
    expect(resolveToolkit("")).toBeNull();
  });
});
