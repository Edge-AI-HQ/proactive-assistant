import {
  useEffect,
  useRef,
  useState,
  type CompositionEvent as ReactCompositionEvent,
  type FormEvent as ReactFormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
  Loader2,
  Hand,
  Bot,
  X,
  Minimize2,
  Keyboard,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  RotateCw,
} from "lucide-react";

interface BrowserViewProps {
  liveViewUrl: string;
  sessionId: string;
  controlMode: "ai" | "user";
  /** Bumped by the parent on foreground/visibility events to force the
   *  iframe to remount — works around iOS pausing the Browserbase WebSocket
   *  while the app was backgrounded, leaving the iframe blank. */
  iframeReloadKey?: number;
  isNative: boolean;
  /** Remote viewport CSS px (what the session was created at). Used to map
   *  overlay-pixel gestures → remote coordinates. */
  viewport: { width: number; height: number };
  onControlChange: (mode: "ai" | "user") => void;
  /** Tap the remote page (touch). Resolves to whether an editable element took
   *  focus → drives the contextual "Type" affordance. */
  onUserInputTap: (x: number, y: number) => Promise<boolean>;
  onUserInputText: (text: string) => Promise<void>;
  onUserInputKey: (key: string) => Promise<void>;
  onUserInputScroll: (dx: number, dy: number) => Promise<void>;
  /** Current page URL (from the session) — shown in the address bar. */
  currentUrl: string;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onNavigate: (url: string) => void;
  /** Collapse back to the input-bar header — keeps the session alive. */
  onCollapse: () => void;
  /** Destroy the remote session. */
  onRequestClose: () => void;
}

/** Movement (CSS px) beyond which a press becomes a scroll, not a tap. */
const TAP_SLOP_PX = 8;
/** A press shorter than this (and within slop) counts as a tap. */
const TAP_MAX_MS = 500;

/**
 * Presentational browser live view — fills whatever container it's given
 * (split column on desktop, bottom-sheet on mobile). The Browserbase live
 * view player downscales the fixed (creation-size) remote frame to fit; we do
 * NOT resize the remote viewport at runtime (the screencast captures the
 * create-time window, so a wider CDP override crops the right edge).
 *
 * Input model:
 *   - Desktop / mouse: the live view iframe takes pointers directly (the
 *     vendor's desktop-mouse model works fine there).
 *   - Touch (phone/tablet): the iframe is read-only; a full-area gesture
 *     overlay captures swipe→scroll and tap→touch and forwards them as raw
 *     CDP touch input. (The vendor live view is desktop-mouse-only, so touch
 *     scroll/tap don't map through it.)
 *
 * Control model: AI drives by default; a transparent capture layer hands
 * control to the user on first interaction (implicit takeover), and the
 * explicit "Take over" button does the same.
 */
export default function BrowserView({
  liveViewUrl,
  sessionId,
  controlMode,
  iframeReloadKey = 0,
  isNative,
  viewport,
  onControlChange,
  onUserInputTap,
  onUserInputText,
  onUserInputKey,
  onUserInputScroll,
  currentUrl,
  onBack,
  onForward,
  onReload,
  onNavigate,
  onCollapse,
  onRequestClose,
}: BrowserViewProps) {
  const { t } = useTranslation(["browser", "common"]);
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const isAi = controlMode === "ai";

  // Gate the touch overlay by REAL input capability, not viewport width: a
  // desktop user with a narrow window gets a mobile session but still drives
  // with a mouse → must keep the direct-iframe path, not the touch overlay.
  const touchInput =
    isNative ||
    (typeof window !== "undefined" &&
      !!window.matchMedia?.("(pointer: coarse)").matches);

  // ── Address bar: a draft synced to the live URL, editable to navigate. ──
  const [urlDraft, setUrlDraft] = useState(currentUrl);
  useEffect(() => setUrlDraft(currentUrl), [currentUrl]);
  const submitUrl = (e: ReactFormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const raw = urlDraft.trim();
    if (!raw) return;
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    onNavigate(url);
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  };

  // ── Soft keyboard via a local hidden input. iOS only raises the keyboard
  //    when focus() runs inside a user-gesture call stack — and tapping a
  //    remote field needs a backend round-trip to know it's editable, which
  //    breaks that gesture context. So instead of auto-raising on field tap,
  //    we surface a contextual "Type" affordance once a field is focused; the
  //    user taps it (a fresh gesture) to raise the keyboard. ──
  const hiddenInputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const [canType, setCanType] = useState(false); // an editable field is focused
  const [kbVisible, setKbVisible] = useState(false);
  useEffect(() => {
    const show = () => setKbVisible(true);
    const hide = () => setKbVisible(false);
    window.addEventListener("pinai:kbShow", show);
    window.addEventListener("pinai:kbHide", hide);
    return () => {
      window.removeEventListener("pinai:kbShow", show);
      window.removeEventListener("pinai:kbHide", hide);
    };
  }, []);
  const flushHidden = (el: HTMLInputElement) => {
    const value = el.value;
    if (!value) return;
    void onUserInputText(value);
    el.value = "";
  };
  const handleHiddenInputInput = (e: ReactFormEvent<HTMLInputElement>) => {
    if (composingRef.current) return;
    flushHidden(e.currentTarget);
  };
  const handleCompositionStart = () => {
    composingRef.current = true;
  };
  const handleCompositionEnd = (e: ReactCompositionEvent<HTMLInputElement>) => {
    composingRef.current = false;
    flushHidden(e.currentTarget);
  };
  const handleHiddenInputKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (composingRef.current) return;
    if (e.key === "Backspace" || e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      void onUserInputKey(e.key);
    }
  };

  // ── Gesture overlay (touch user mode). Classifies a pointer sequence into a
  //    tap (touch → CDP) or a pan (→ remote scroll, content-follows-finger).
  //    Scroll deltas are scaled to remote CSS px and flushed once per frame. ──
  const boxRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<{
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    startedAt: number;
    moved: boolean;
    pointerId: number;
  } | null>(null);
  const accumRef = useRef({ dx: 0, dy: 0 });
  const rafRef = useRef<number | null>(null);

  const flushScroll = () => {
    rafRef.current = null;
    const { dx, dy } = accumRef.current;
    accumRef.current = { dx: 0, dy: 0 };
    if (dx !== 0 || dy !== 0) void onUserInputScroll(Math.round(dx), Math.round(dy));
  };
  const remoteScale = () => {
    const r = boxRef.current?.getBoundingClientRect();
    if (!r || r.width < 1 || r.height < 1) return null;
    return { r, sx: viewport.width / r.width, sy: viewport.height / r.height };
  };
  const handleOverlayDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    gestureRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      startedAt: Date.now(),
      moved: false,
      pointerId: e.pointerId,
    };
  };
  const handleOverlayMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    if (!g || g.pointerId !== e.pointerId) return;
    const scale = remoteScale();
    if (!scale) return;
    const fdx = e.clientX - g.lastX;
    const fdy = e.clientY - g.lastY;
    g.lastX = e.clientX;
    g.lastY = e.clientY;
    if (
      Math.abs(e.clientX - g.startX) > TAP_SLOP_PX ||
      Math.abs(e.clientY - g.startY) > TAP_SLOP_PX
    ) {
      g.moved = true;
    }
    if (g.moved) {
      // Content follows finger: swipe up → page scrolls down (wheel +Y).
      accumRef.current.dx += -fdx * scale.sx;
      accumRef.current.dy += -fdy * scale.sy;
      if (rafRef.current === null) rafRef.current = requestAnimationFrame(flushScroll);
    }
  };
  const handleOverlayUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    gestureRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      flushScroll();
    }
    if (!g) return;
    if (!g.moved && Date.now() - g.startedAt < TAP_MAX_MS) {
      const scale = remoteScale();
      if (!scale) return;
      const x = (g.startX - scale.r.left) * scale.sx;
      const y = (g.startY - scale.r.top) * scale.sy;
      void onUserInputTap(x, y).then((editable) => {
        // Don't auto-raise the keyboard (iOS needs a gesture); surface the
        // contextual Type affordance instead. A non-editable tap clears it
        // and dismisses any open keyboard.
        setCanType(editable);
        if (!editable) hiddenInputRef.current?.blur();
      });
    }
  };
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const ctrlBtn =
    "flex items-center gap-1 px-2.5 py-1 rounded-full text-caption transition-colors";

  // navbar=false strips the live-view player's faux address bar so our own
  // control bar is the only chrome and the page uses the full panel height.
  const iframeSrc = liveViewUrl.includes("?")
    ? `${liveViewUrl}&navbar=false`
    : `${liveViewUrl}?navbar=false`;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[hsl(230_22%_9%)]">
      {/* Top control bar — control toggle on the left; collapse / end-session
          on the right. No status pill: the toggle reads "Take over" (AI
          driving) vs "Return to AI" (you're driving). */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/[0.06] bg-[hsl(230_18%_13%)] px-3 py-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {isAi ? (
            <button
              onClick={() => onControlChange("user")}
              className={`${ctrlBtn} bg-white/[0.08] text-white/85 hover:bg-white/15 active:bg-white/20`}
            >
              <Hand size={12} strokeWidth={2} />
              <span>{t("view.takeOver")}</span>
            </button>
          ) : (
            <button
              onClick={() => onControlChange("ai")}
              className={`${ctrlBtn} bg-blue-500/25 text-blue-100 hover:bg-blue-500/40 active:bg-blue-500/50`}
            >
              <Bot size={12} strokeWidth={2} />
              <span>{t("view.returnToAi")}</span>
            </button>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {confirmingClose ? (
            <>
              <button
                onClick={() => setConfirmingClose(false)}
                className="rounded-md px-2.5 py-1 text-caption text-white/75 hover:bg-white/10"
              >
                {t("common:status.cancel")}
              </button>
              <button
                onClick={() => {
                  setConfirmingClose(false);
                  onRequestClose();
                }}
                className="rounded-md bg-red-500/85 px-2.5 py-1 text-caption font-medium text-white hover:bg-red-500"
              >
                {t("view.endSession")}
              </button>
            </>
          ) : (
            <>
              <button
                onClick={onCollapse}
                className="rounded-md p-1.5 text-white/65 hover:bg-white/10 active:bg-white/15"
                title={t("view.collapse")}
              >
                <Minimize2 size={15} strokeWidth={2} />
              </button>
              <button
                onClick={() => setConfirmingClose(true)}
                className="rounded-md p-1.5 text-white/65 hover:bg-white/10 active:bg-white/15"
                title={t("view.endBrowserSession")}
              >
                <X size={15} strokeWidth={2} />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Address bar — back / forward / reload + editable URL. */}
      <form
        onSubmit={submitUrl}
        className="flex shrink-0 items-center gap-1 border-b border-white/[0.06] bg-[hsl(230_18%_13%)] px-2 pb-2"
      >
        <button
          type="button"
          onClick={onBack}
          title={t("view.back")}
          className="rounded-md p-1.5 text-white/65 hover:bg-white/10 active:bg-white/15"
        >
          <ChevronLeft size={16} strokeWidth={2} />
        </button>
        <button
          type="button"
          onClick={onForward}
          title={t("view.forward")}
          className="rounded-md p-1.5 text-white/65 hover:bg-white/10 active:bg-white/15"
        >
          <ChevronRight size={16} strokeWidth={2} />
        </button>
        <button
          type="button"
          onClick={onReload}
          title={t("view.reload")}
          className="rounded-md p-1.5 text-white/65 hover:bg-white/10 active:bg-white/15"
        >
          <RotateCw size={14} strokeWidth={2} />
        </button>
        <input
          value={urlDraft}
          onChange={(e) => setUrlDraft(e.target.value)}
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          placeholder={t("view.enterUrl")}
          aria-label={t("view.addressBar")}
          className="min-w-0 flex-1 truncate rounded-full bg-white/[0.08] px-3 py-1 text-caption text-white/85 outline-none placeholder:text-white/35 focus:bg-white/[0.12]"
        />
      </form>

      {/* Live-view box. The iframe fills it; the Browserbase player downscales
          the fixed remote frame to fit (no runtime resize — see file header). */}
      <div ref={boxRef} className="relative flex-1 overflow-hidden bg-black">
        {!iframeLoaded && (
          <div className="absolute inset-0 z-[1] flex items-center justify-center bg-black/80">
            <div className="flex items-center gap-2">
              <Loader2 size={14} className="animate-spin text-white/50" />
              <span className="text-bodySm text-white/50">{t("view.loading")}</span>
            </div>
          </div>
        )}
        <iframe
          key={`iframe-${iframeReloadKey}`}
          src={iframeSrc}
          onLoad={() => setIframeLoaded(true)}
          sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
          allow="clipboard-read; clipboard-write; fullscreen"
          title={t("view.iframeTitle", { id: sessionId })}
          className="absolute inset-0 h-full w-full"
          style={{
            border: 0,
            display: "block",
            // Direct interaction only for desktop mouse in user mode; AI mode
            // and the touch overlay both own pointers above the iframe.
            pointerEvents: !isAi && !touchInput ? "auto" : "none",
          }}
        />

        {/* Implicit takeover: in AI mode a transparent layer catches the first
            interaction and hands control to the user (the agent's mutations are
            gated server-side until then). Pairs with the explicit "Take over"
            button — two paths to the same state. */}
        {isAi && (
          <button
            type="button"
            onClick={() => onControlChange("user")}
            className="absolute inset-0 z-10 cursor-pointer bg-transparent"
            aria-label={t("view.takeControl")}
            title={t("view.tapToTakeControl")}
          />
        )}

        {/* Touch gesture overlay (user mode): swipe→scroll, tap→touch. */}
        {!isAi && touchInput && (
          <div
            onPointerDown={handleOverlayDown}
            onPointerMove={handleOverlayMove}
            onPointerUp={handleOverlayUp}
            onPointerCancel={handleOverlayUp}
            style={{ touchAction: "none" }}
            className="absolute inset-0 z-10"
          />
        )}

        {/* Contextual keyboard affordance (touch user mode): appears once a
            tap focuses an editable field. Tapping it is a fresh user gesture,
            so iOS reliably raises the keyboard. */}
        {!isAi && touchInput && canType && (
          <button
            type="button"
            // Don't blur the hidden input on press (keep focus for the keyboard).
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (kbVisible) hiddenInputRef.current?.blur();
              else hiddenInputRef.current?.focus();
            }}
            className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-white/10 bg-black/70 px-3.5 py-2 text-caption text-white/90 backdrop-blur-sm active:bg-black/85"
          >
            {kbVisible ? (
              <>
                <ChevronDown size={14} strokeWidth={2} />
                <span>{t("common:status.done")}</span>
              </>
            ) : (
              <>
                <Keyboard size={14} strokeWidth={2} />
                <span>{t("view.summonKeyboard")}</span>
              </>
            )}
          </button>
        )}

        <input
          ref={hiddenInputRef}
          type="text"
          defaultValue=""
          onInput={handleHiddenInputInput}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onKeyDown={handleHiddenInputKeyDown}
          inputMode="text"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          aria-hidden="true"
          tabIndex={-1}
          style={{
            position: "fixed",
            left: -9999,
            top: 0,
            width: 1,
            height: 1,
            opacity: 0,
            pointerEvents: "none",
          }}
        />
      </div>
    </div>
  );
}
