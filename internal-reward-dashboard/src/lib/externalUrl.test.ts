import { describe, expect, it } from "vitest";
import { safeExternalHref } from "./externalUrl";

describe("safeExternalHref", () => {
  it("keeps absolute http and https links", () => {
    expect(safeExternalHref("https://smith.langchain.com/o/trace/1")).toBe("https://smith.langchain.com/o/trace/1");
    expect(safeExternalHref("http://localhost:8000/trace")).toBe("http://localhost:8000/trace");
    expect(safeExternalHref(" https://smith.langchain.com/o/trace/1 ")).toBe("https://smith.langchain.com/o/trace/1");
  });

  it("rejects non-web and malformed links", () => {
    expect(safeExternalHref("javascript:alert(1)")).toBeNull();
    expect(safeExternalHref("/relative/path")).toBeNull();
    expect(safeExternalHref("not a url")).toBeNull();
    expect(safeExternalHref(null)).toBeNull();
  });
});
