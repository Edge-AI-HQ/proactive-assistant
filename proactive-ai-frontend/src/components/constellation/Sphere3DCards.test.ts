import { describe, expect, test } from "vitest";

import { getSphereCardPresentation } from "./Sphere3DCards";

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
