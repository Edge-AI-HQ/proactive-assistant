import { describe, expect, test } from "vitest";

import { resolveDisplayPlace } from "./location";

describe("resolveDisplayPlace", () => {
  const base = { latitude: 37.7749, longitude: -122.4194 };

  test("uses exact place only when accuracy and POI distance are both tight", () => {
    expect(resolveDisplayPlace({
      ...base,
      accuracy: 15,
      candidate: { name: "Coffee Shop", distance_m: 12 },
      address: "Main St",
    }).mode).toBe("exact_place");
  });

  test("downgrades plausible but broad POI matches to nearby", () => {
    expect(resolveDisplayPlace({
      ...base,
      accuracy: 80,
      candidate: { name: "Driving School", distance_m: 45 },
      address: "Main St",
    })).toMatchObject({
      mode: "nearby_poi",
      label: "Near Driving School",
    });
  });

  test("uses area or address when POI is too weak for the current accuracy", () => {
    expect(resolveDisplayPlace({
      ...base,
      accuracy: 120,
      candidate: { name: "Driving School", distance_m: 90 },
      address: "Main St",
    })).toMatchObject({
      mode: "area",
      label: "Main St",
    });
  });

  test("falls back to coordinates when no place text is available", () => {
    expect(resolveDisplayPlace({
      ...base,
      accuracy: 120,
    })).toMatchObject({
      mode: "coordinates",
      label: "37.7749, -122.4194 ±120m",
    });
  });
});
