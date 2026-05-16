/**
 * Device hints for the chat-stream/send body.
 *
 * Sent on every chat turn so the backend can size the Browserbase
 * remote browser viewport + select a mobile/tablet/desktop user agent.
 * Most sites pick mobile vs desktop layout off the UA; matching it to
 * the panel CSS width gives the user a 1:1 in-app browsing experience
 * with no scaling artifacts.
 *
 * Wired into POST /chat-stream/send (web → chat) — see chat_proxy.py /
 * routes/chat.py on the backend.
 */
import { useEffect, useState } from "react";

export type DeviceKind = "mobile" | "tablet" | "desktop";

export interface ClientHints {
  viewportWidth: number;
  viewportHeight: number;
  deviceKind: DeviceKind;
}

// CSS px breakpoints — matches Tailwind's md/lg defaults so a tablet in
// landscape still gets a tablet UA, not desktop.
const MOBILE_MAX = 768;
const TABLET_MAX = 1024;

// Coarse pointer = touch device. With a small screen this disambiguates
// "narrow desktop window" (mouse) from "phone" (no mouse). Sites that
// pick mobile layout off pointer:coarse rather than UA still get the
// right hint.
function probe(): ClientHints {
  // SSR / pre-paint fallback — pick desktop so we don't accidentally
  // serve a tiny mobile viewport to a desktop user on first turn.
  if (typeof window === "undefined") {
    return { viewportWidth: 1280, viewportHeight: 800, deviceKind: "desktop" };
  }
  const w = Math.max(1, Math.round(window.innerWidth));
  const h = Math.max(1, Math.round(window.innerHeight));
  const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;

  let kind: DeviceKind;
  if (w < MOBILE_MAX && coarse) {
    kind = "mobile";
  } else if (w < TABLET_MAX && coarse) {
    kind = "tablet";
  } else if (w < MOBILE_MAX) {
    // Narrow desktop window — treat as mobile so the remote browser
    // also goes narrow; without `coarse` we just don't trigger the
    // mobile-UA stealth profile.
    kind = "mobile";
  } else {
    kind = "desktop";
  }
  return { viewportWidth: w, viewportHeight: h, deviceKind: kind };
}

/**
 * Live device hints, recomputed on resize / orientation change.
 *
 * The remote browser viewport tracks the *current* window. We don't
 * recreate the Browserbase session on every resize — the chat-side
 * manager keeps a session keyed by (session_key, profile) and only
 * recreates when the profile actually differs, so rapid resizes are
 * cheap (each chat turn carries the latest hint; same hint → reuse).
 */
export function useClientHints(): ClientHints {
  const [hints, setHints] = useState<ClientHints>(() => probe());

  useEffect(() => {
    if (typeof window === "undefined") return;
    let frame = 0;
    const onChange = () => {
      // Debounce resize storms (drag-to-resize on desktop, keyboard
      // show/hide on mobile fires several pixel-level resizes).
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setHints(probe()));
    };
    window.addEventListener("resize", onChange);
    window.addEventListener("orientationchange", onChange);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("resize", onChange);
      window.removeEventListener("orientationchange", onChange);
    };
  }, []);

  return hints;
}
