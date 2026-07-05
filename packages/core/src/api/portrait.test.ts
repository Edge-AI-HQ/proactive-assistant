import { describe, expect, test } from "vitest";
import { splitPortraitEntries } from "./portrait";

describe("splitPortraitEntries", () => {
  test("empty / undefined content → no entries", () => {
    expect(splitPortraitEntries(undefined)).toEqual([]);
    expect(splitPortraitEntries("")).toEqual([]);
    expect(splitPortraitEntries("   ")).toEqual([]);
  });

  test("single entry → one trimmed entry", () => {
    expect(splitPortraitEntries("  Builds personal AI products.  ")).toEqual([
      "Builds personal AI products.",
    ]);
  });

  test("§-delimited block → trimmed entries, empties dropped", () => {
    // Mirrors the backend _join format: `\n§\n` between entries.
    const content = "First fact\n§\nSecond fact\n§\nThird fact";
    expect(splitPortraitEntries(content)).toEqual([
      "First fact",
      "Second fact",
      "Third fact",
    ]);
  });

  test("consecutive separators / blank entries are filtered out", () => {
    expect(splitPortraitEntries("§§ kept §  § also kept §")).toEqual([
      "kept",
      "also kept",
    ]);
  });

  test("multi-line markdown entries are preserved intact", () => {
    const content = "# Heading\n\nbody line\n§\n- bullet one\n- bullet two";
    expect(splitPortraitEntries(content)).toEqual([
      "# Heading\n\nbody line",
      "- bullet one\n- bullet two",
    ]);
  });
});
