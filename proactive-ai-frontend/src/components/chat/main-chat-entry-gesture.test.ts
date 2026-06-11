import { describe, expect, test } from "vitest";
import {
  isFromLeftEdgeOfScreen,
  isFromLowerHalfOfScreen,
  isMainChatSurfaceSwipeUp,
  LEFT_EDGE_BACK_THRESHOLD_PX,
} from "@/components/chat/main-chat-entry-gesture";

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

describe("isFromLowerHalfOfScreen", () => {
  test("true at and below the vertical midpoint", () => {
    expect(isFromLowerHalfOfScreen(400, 800)).toBe(true);
    expect(isFromLowerHalfOfScreen(799, 800)).toBe(true);
  });
  test("false above the midpoint", () => {
    expect(isFromLowerHalfOfScreen(399, 800)).toBe(false);
    expect(isFromLowerHalfOfScreen(0, 800)).toBe(false);
  });
});

describe("isMainChatSurfaceSwipeUp", () => {
  test("null start never matches", () => {
    expect(isMainChatSurfaceSwipeUp(null, { x: 0, y: 0 })).toBe(false);
  });
  test("requires the deliberate 56px upward travel (stricter than the button's 36px)", () => {
    const start = { x: 100, y: 600 };
    // 40px up would satisfy the button threshold but not the surface one.
    expect(isMainChatSurfaceSwipeUp(start, { x: 100, y: 560 })).toBe(false);
    expect(isMainChatSurfaceSwipeUp(start, { x: 100, y: 544 })).toBe(true);
  });
  test("vertical travel must dominate horizontal (sphere drags stay sphere drags)", () => {
    const start = { x: 100, y: 600 };
    expect(isMainChatSurfaceSwipeUp(start, { x: 180, y: 530 })).toBe(false);
    expect(isMainChatSurfaceSwipeUp(start, { x: 120, y: 530 })).toBe(true);
  });
  test("downward travel never matches", () => {
    const start = { x: 100, y: 400 };
    expect(isMainChatSurfaceSwipeUp(start, { x: 100, y: 500 })).toBe(false);
  });
});
