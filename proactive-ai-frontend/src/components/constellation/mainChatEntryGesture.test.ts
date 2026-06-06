import { describe, expect, test } from "vitest";
import {
  isFromLeftEdgeOfScreen,
  LEFT_EDGE_BACK_THRESHOLD_PX,
} from "./mainChatEntryGesture";

describe("isFromLeftEdgeOfScreen", () => {
  test("true when pointer starts within the left-edge zone", () => {
    expect(isFromLeftEdgeOfScreen(0)).toBe(true);
    expect(isFromLeftEdgeOfScreen(LEFT_EDGE_BACK_THRESHOLD_PX - 1)).toBe(true);
  });
  test("false when pointer starts further inward", () => {
    expect(isFromLeftEdgeOfScreen(LEFT_EDGE_BACK_THRESHOLD_PX + 1)).toBe(false);
    expect(isFromLeftEdgeOfScreen(200)).toBe(false);
  });
});
