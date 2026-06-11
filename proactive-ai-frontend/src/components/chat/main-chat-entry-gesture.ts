export type TouchPoint = { x: number; y: number };

const MAIN_CHAT_ENTRY_SWIPE_THRESHOLD_PX = 36;
const MAIN_CHAT_EXIT_SWIPE_THRESHOLD_PX = 36;
const MAIN_MENU_SWIPE_THRESHOLD_PX = 48;
const MAIN_MENU_SWIPE_IGNORE_ATTR = "data-main-menu-swipe-ignore";

/**
 * Width of the screen-edge zone (in pixels from the right edge) where a
 * touch starting there is treated as "open menu" intent — iOS-style
 * system gesture model. A swipe starting further inward goes to the
 * content (e.g. Sphere3DCards card drag) instead.
 */
export const MAIN_MENU_EDGE_OPEN_THRESHOLD_PX = 24;

/**
 * True when the pointer started in the right-edge zone of the screen.
 * Caller passes window.innerWidth so this stays SSR-safe and easy to test.
 */
export function isFromRightEdgeOfScreen(
  clientX: number,
  screenWidth: number,
): boolean {
  return clientX >= screenWidth - MAIN_MENU_EDGE_OPEN_THRESHOLD_PX;
}

export function isMainChatEntrySwipeUp(
  start: TouchPoint | null,
  end: TouchPoint,
): boolean {
  if (!start) return false;
  const verticalTravel = start.y - end.y;
  const horizontalTravel = Math.abs(end.x - start.x);
  return (
    verticalTravel >= MAIN_CHAT_ENTRY_SWIPE_THRESHOLD_PX
    && verticalTravel > horizontalTravel
  );
}

/** The whole lower half of the NOW screen accepts the swipe-up into main
 *  chat, not just the ASK PIN AI button. The sphere only responds to
 *  HORIZONTAL drags (pitch is locked), so a vertical swipe there is an
 *  otherwise-dead gesture we can claim without stealing anything. */
const MAIN_CHAT_SURFACE_SWIPE_THRESHOLD_PX = 56;

/** True when the pointer started in the lower half of the screen. */
export function isFromLowerHalfOfScreen(
  clientY: number,
  screenHeight: number,
): boolean {
  return clientY >= screenHeight / 2;
}

/** Swipe-up detector for the lower-screen surface. Deliberately a HIGHER
 *  threshold than the button's own (56px vs 36px): a half-screen hot zone
 *  needs a more deliberate gesture to stay clear of accidental flicks. */
export function isMainChatSurfaceSwipeUp(
  start: TouchPoint | null,
  end: TouchPoint,
): boolean {
  if (!start) return false;
  const verticalTravel = start.y - end.y;
  const horizontalTravel = Math.abs(end.x - start.x);
  return (
    verticalTravel >= MAIN_CHAT_SURFACE_SWIPE_THRESHOLD_PX
    && verticalTravel > horizontalTravel
  );
}

/**
 * Mirror of isMainChatEntrySwipeUp for the exit direction: vertical
 * downward travel exceeding the threshold (and dominating any horizontal
 * jitter) means the user wants to dismiss the landing page back to the
 * Constellation. Used by MinimalistLanding.
 */
export function isMainChatExitSwipeDown(
  start: TouchPoint | null,
  end: TouchPoint,
): boolean {
  if (!start) return false;
  const verticalTravel = end.y - start.y;
  const horizontalTravel = Math.abs(end.x - start.x);
  return (
    verticalTravel >= MAIN_CHAT_EXIT_SWIPE_THRESHOLD_PX
    && verticalTravel > horizontalTravel
  );
}

/**
 * Returns true if the gesture target sits inside an interactive surface
 * (textarea / input / button / contenteditable) where a swipe would
 * conflict with text editing, selection, or button activation. Used by
 * MinimalistLanding's swipe-to-close so the user can still interact with
 * the composer + suggestion chips without accidentally dismissing.
 */
export function shouldIgnoreLandingExitSwipe(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest("textarea, input, button, [contenteditable='true']")) {
    return true;
  }
  return false;
}

export function isMainMenuSwipeLeft(
  start: TouchPoint | null,
  end: TouchPoint,
): boolean {
  if (!start) return false;
  const horizontalTravel = start.x - end.x;
  const verticalTravel = Math.abs(end.y - start.y);
  return (
    horizontalTravel >= MAIN_MENU_SWIPE_THRESHOLD_PX
    && horizontalTravel > verticalTravel
  );
}

export function isMainMenuSwipeRight(
  start: TouchPoint | null,
  end: TouchPoint,
): boolean {
  if (!start) return false;
  const horizontalTravel = end.x - start.x;
  const verticalTravel = Math.abs(end.y - start.y);
  return (
    horizontalTravel >= MAIN_MENU_SWIPE_THRESHOLD_PX
    && horizontalTravel > verticalTravel
  );
}

export function shouldIgnoreMainMenuSwipeTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(`[${MAIN_MENU_SWIPE_IGNORE_ATTR}="true"]`) !== null;
}

/**
 * Width of the screen-edge zone (px from the LEFT edge) where a touch
 * is treated as "go back" intent — mirrors MAIN_MENU_EDGE_OPEN_THRESHOLD_PX
 * on the right edge. Kept narrow so it doesn't steal horizontal scrolls /
 * sphere drags that start mid-screen.
 */
export const LEFT_EDGE_BACK_THRESHOLD_PX = 20;

/** True when the pointer started in the left-edge zone of the screen. */
export function isFromLeftEdgeOfScreen(clientX: number): boolean {
  return clientX <= LEFT_EDGE_BACK_THRESHOLD_PX;
}
