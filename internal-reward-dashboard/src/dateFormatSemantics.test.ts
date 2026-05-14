import { describe, expect, it } from "vitest";

const routeSources = import.meta.glob("./routes/*.tsx", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

describe("date formatting semantics", () => {
  it("routes backend timestamps through the safe formatter instead of direct Date locale rendering", () => {
    const directLocaleDateFormatting = Object.entries(routeSources).flatMap(([path, source]) =>
      [...source.matchAll(/new Date\([^)]+\)\.toLocaleString/g)]
        .map((match) => `${path}: ${match[0]}`),
    );

    expect(directLocaleDateFormatting).toEqual([]);
  });
});
