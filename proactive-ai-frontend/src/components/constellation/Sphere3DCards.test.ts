import { describe, expect, test } from "vitest";

import { getSphereCardPresentation } from "./Sphere3DCards";

describe("getSphereCardPresentation", () => {
  test("hides back-half cards so their text cannot overlap foreground cards", () => {
    expect(getSphereCardPresentation(0.2)).toEqual({ opacity: 0, visible: false });
    expect(getSphereCardPresentation(0.47)).toEqual({ opacity: 0, visible: false });
  });

  test("keeps readable cards visible as they rotate toward the front", () => {
    const sideCard = getSphereCardPresentation(0.5);
    const frontCard = getSphereCardPresentation(1);

    expect(sideCard.visible).toBe(true);
    expect(sideCard.opacity).toBeGreaterThan(0.46);
    expect(frontCard).toEqual({ opacity: 1, visible: true });
  });
});
