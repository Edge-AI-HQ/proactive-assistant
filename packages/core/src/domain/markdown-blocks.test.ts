import { describe, expect, it } from "vitest";

import { splitBlocks } from "./markdown-blocks";

// Note: a block keeps the blank line that terminated it (trailing "\n"). This
// is the exact behavior lifted from RN MarkdownText — harmless to the markdown
// renderer and deterministic, so block-memo keys stay stable. Tests assert the
// real output rather than an idealized trimmed shape.
describe("splitBlocks", () => {
  it("splits paragraphs at blank lines", () => {
    expect(splitBlocks("a\n\nb\n\nc")).toEqual(["a\n", "b\n", "c"]);
  });

  it("keeps a fenced code block intact even with blank lines inside", () => {
    const text = "intro\n\n```ts\nconst x = 1;\n\nconst y = 2;\n```\n\nafter";
    expect(splitBlocks(text)).toEqual([
      "intro\n",
      "```ts\nconst x = 1;\n\nconst y = 2;\n```\n",
      "after",
    ]);
  });

  it("handles ~~~ fences too", () => {
    const text = "~~~\nline1\n\nline2\n~~~";
    expect(splitBlocks(text)).toEqual(["~~~\nline1\n\nline2\n~~~"]);
  });

  it("drops empty/whitespace-only blocks", () => {
    expect(splitBlocks("a\n\n\n\nb")).toEqual(["a\n", "b"]);
    expect(splitBlocks("\n\n   \n\n")).toEqual([]);
  });

  it("flushes the trailing block without a final blank line", () => {
    expect(splitBlocks("only block")).toEqual(["only block"]);
  });

  it("treats an unterminated fence as still inside (last streaming block)", () => {
    // Mid-stream: the closing ``` has not arrived, so the blank line after the
    // partial code must NOT split it off.
    const text = "```ts\nconst x = 1;\n\nconst y = 2;";
    expect(splitBlocks(text)).toEqual(["```ts\nconst x = 1;\n\nconst y = 2;"]);
  });
});
