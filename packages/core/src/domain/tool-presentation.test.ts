import { describe, expect, test } from "vitest";

import { resolveToolPresentationMeta } from "./tool-presentation";

describe("resolveToolPresentationMeta", () => {
  test("精确名 → iconKey + verb", () => {
    expect(resolveToolPresentationMeta("python_exec")).toEqual({ iconKey: "terminal", verb: "Ran Python" });
    expect(resolveToolPresentationMeta("web_search")).toEqual({ iconKey: "search", verb: "Searched web" });
  });

  test("Composio 前缀匹配(顺序敏感:具体在前)", () => {
    expect(resolveToolPresentationMeta("GMAIL_FETCH_EMAILS")).toEqual({ iconKey: "mail", verb: "Searched Gmail" });
    expect(resolveToolPresentationMeta("GMAIL_SEND_DRAFT")).toEqual({ iconKey: "mail", verb: "Drafted email" });
    expect(resolveToolPresentationMeta("GCAL_FIND_FREE_SLOTS")).toEqual({ iconKey: "calendar", verb: "Read calendar" });
  });

  test("未知 → wrench + title-case", () => {
    expect(resolveToolPresentationMeta("some_unknown_tool")).toEqual({ iconKey: "wrench", verb: "Some Unknown Tool" });
  });
});
