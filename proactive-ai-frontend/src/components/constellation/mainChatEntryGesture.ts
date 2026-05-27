export type TouchPoint = { x: number; y: number };

const MAIN_CHAT_ENTRY_SWIPE_THRESHOLD_PX = 36;
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
