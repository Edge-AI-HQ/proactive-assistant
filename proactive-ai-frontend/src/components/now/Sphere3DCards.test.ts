import { describe, expect, test } from "vitest";

import {
  computeCardStyle,
  getSphereCardPresentation,
} from "@/components/now/Sphere3DCards";

describe("getSphereCardPresentation", () => {
  test("keeps back-half cards visible but dimmed", () => {
    expect(getSphereCardPresentation(0.2)).toEqual({ opacity: 0.456, visible: true });
    expect(getSphereCardPresentation(0.47)).toEqual({ opacity: 0.6396, visible: true });
  });

  test("keeps readable cards visible as they rotate toward the front", () => {
    const sideCard = getSphereCardPresentation(0.5);
    const frontCard = getSphereCardPresentation(1);

    expect(sideCard.visible).toBe(true);
    expect(sideCard.opacity).toBeGreaterThan(0.46);
    expect(frontCard).toEqual({ opacity: 1, visible: true });
  });
});

// computeCardStyle is the single source for the depth-driven styles that
// both render and the imperative rAF loop write — these tests pin the
// legacy formulas it absorbed.
describe("computeCardStyle", () => {
  const P = { x: 0.4, y: 0.3, z: Math.sqrt(1 - 0.4 * 0.4 - 0.3 * 0.3) };

  test("front-facing card gets full styling (z>0 shadow, tappable)", () => {
    // yaw=0 keeps P near the front (z component dominates).
    const s = computeCardStyle(P, 0, -10, 130, 170);
    expect(s.depth).toBeGreaterThan(0.5);
    expect(s.boxShadow).toContain("rgba");
    expect(s.pointerEvents).toBe("auto");
    expect(s.zIndex).toBe(Math.round(1000 + (s.depth * 2 - 1) * 130));
    expect(s.opacity).toBeCloseTo(
      Math.round(getSphereCardPresentation(s.depth).opacity * 100) / 100,
      6,
    );
  });

  test("back-facing card loses shadow and pointer events", () => {
    // Rotate the same point half a revolution to the back.
    const s = computeCardStyle(P, 180, -10, 130, 170);
    expect(s.depth).toBeLessThan(0.25);
    expect(s.boxShadow).toBe("none");
    expect(s.pointerEvents).toBe("none");
  });

  test("transform centers the 160×68 card box and scales with depth", () => {
    const s = computeCardStyle(P, 33, -10, 130, 170);
    expect(s.transform).toMatch(
      /^translate3d\(-?\d+\.\d{2}px, -?\d+\.\d{2}px, 0\) scale\(\d\.\d{3}\)$/,
    );
    const scale = Number(/scale\((.+)\)/.exec(s.transform)![1]);
    expect(scale).toBeCloseTo(0.6 + s.depth * 0.65, 3);
  });

  test("is periodic — one full revolution returns the same frame", () => {
    const a = computeCardStyle(P, 33, -10, 130, 170);
    const b = computeCardStyle(P, 33 + 360, -10, 130, 170);
    expect(b.transform).toBe(a.transform);
    expect(b.opacity).toBe(a.opacity);
    expect(b.zIndex).toBe(a.zIndex);
  });
});
