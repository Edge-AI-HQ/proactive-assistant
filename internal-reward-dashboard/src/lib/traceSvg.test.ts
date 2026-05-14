import { describe, expect, it } from "vitest";
import { sanitizeTraceSvg, traceSvgDataUrl } from "./traceSvg";

describe("trace SVG rendering", () => {
  it("sanitizes active SVG content before image rendering", () => {
    const svg = `
      <?xml-stylesheet href="https://example.test/style.css"?>
      <svg onload="alert(1)">
        <script>alert(1)</script>
        <foreignObject><iframe src="https://example.test"></iframe></foreignObject>
        <style>text { background: url(javascript:alert(1)); }</style>
        <a href="javascript:alert(1)" xlink:href="data:image/svg+xml,<svg></svg>">bad</a>
        <use href="&#x6a;&#x61;vascript:alert(1)" />
        <text>safe trace</text>
      </svg>
    `;

    const src = traceSvgDataUrl(svg);

    expect(src).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    expect(src).not.toContain("<script>");
    const decoded = decodeURIComponent(src.split(",")[1]);
    expect(decoded).toContain("<svg>");
    expect(decoded).toContain("safe trace");
    expect(decoded).not.toContain("<?xml-stylesheet");
    expect(decoded).not.toContain("onload");
    expect(decoded).not.toContain("<script");
    expect(decoded).not.toContain("<foreignObject");
    expect(decoded).not.toContain("<iframe");
    expect(decoded).not.toContain("<style");
    expect(decoded).not.toContain("javascript:");
    expect(decoded).not.toContain("data:image/svg");
  });

  it("keeps safe SVG links and rejects non-SVG input", () => {
    expect(sanitizeTraceSvg('<svg><a href="https://example.test/trace">trace</a></svg>'))
      .toBe('<svg><a href="https://example.test/trace">trace</a></svg>');
    expect(traceSvgDataUrl("<div>not svg</div>")).toBe("");
  });

  it("does not throw on malformed numeric entities in URL attributes", () => {
    const src = traceSvgDataUrl('<svg><a href="&#999999999999999999999999;">trace</a></svg>');

    expect(src).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
  });

  it("does not render an empty SVG source", () => {
    expect(traceSvgDataUrl("  ")).toBe("");
  });
});
