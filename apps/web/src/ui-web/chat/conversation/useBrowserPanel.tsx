import { useCallback, useEffect, useRef, useState } from "react";
import BrowserView from "../../browser/BrowserView";
import { useBrowserSession } from "../../browser/useBrowserSession";
import { useMediaQuery } from "../../lib/use-media-query";

export type BrowserLayout = "hidden" | "split" | "drawer";

/**
 * Browser live-view panel state + input wiring, extracted from ConversationView.
 * Keyed by the resolved thread id so browser_tool's session for THIS thread
 * streams into the panel. Empty until the thread id is known (main thread is
 * server-resolved via the stream hello) — useBrowserSession idles on "".
 * Returns everything the view needs to render the split column / drawer / header.
 */
export function useBrowserPanel(
  threadId: string | null,
  enableBrowserSplit: boolean,
  onBrowserSplitChange?: (active: boolean) => void,
) {
  const browserSessionKey = threadId ?? "";
  const {
    session: browserSession,
    panelOpen: browserPanelOpen,
    openPanel: openBrowserPanel,
    closePanel: closeBrowserPanel,
    setControl,
    sendInput,
    refreshLiveView,
    close: closeBrowser,
  } = useBrowserSession(browserSessionKey);

  // Browser panel layout. Wide hosts that opted into split render it as a left
  // column beside the chat; everything else (phone-width) gets a bottom-sheet
  // drawer. Hidden until the user opens it from the header (default closed).
  const wideViewport = useMediaQuery("(min-width: 1024px)");
  const canSplitBrowser = enableBrowserSplit && wideViewport;
  const browserLayout: BrowserLayout =
    !browserSession || !browserPanelOpen
      ? "hidden"
      : canSplitBrowser
        ? "split"
        : "drawer";
  // Ask the host shell to widen this view for the split (chat keeps its width;
  // the browser takes the freed space). The drawer needs no host change.
  const browserSplitActive = browserLayout === "split";
  useEffect(() => {
    onBrowserSplitChange?.(browserSplitActive);
  }, [browserSplitActive, onBrowserSplitChange]);

  // On tab foreground return, the Live View's signed iframe URL may have
  // expired. Refresh the URL then bump the iframe key (don't remount the
  // transcript — that would drop the in-flight stream / composer draft).
  const [iframeReloadKey, setIframeReloadKey] = useState(0);
  const lastReloadAtRef = useRef(0);
  useEffect(() => {
    const bump = () => {
      const now = Date.now();
      if (now - lastReloadAtRef.current < 1500) return;
      lastReloadAtRef.current = now;
      void (async () => {
        await refreshLiveView();
        setIframeReloadKey((k) => k + 1);
      })();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") bump();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refreshLiveView]);

  // BrowserView speaks (mode, key, dx, dy); wrap the hook's typed sendInput.
  const handleUserInputText = useCallback(
    (text: string) => sendInput({ type: "text", text }).then(() => undefined),
    [sendInput],
  );
  const handleUserInputKey = useCallback(
    (key: string) => sendInput({ type: "key", key }).then(() => undefined),
    [sendInput],
  );
  const handleUserInputScroll = useCallback(
    (dx: number, dy: number) =>
      sendInput({ type: "scroll", dx, dy }).then(() => undefined),
    [sendInput],
  );
  const handleUserInputTap = useCallback(
    (x: number, y: number) =>
      sendInput({ type: "tap", x, y }).then((r) => !!(r && r.editableFocused)),
    [sendInput],
  );
  const handleBrowserControlChange = useCallback(
    (mode: "ai" | "user") => void setControl(mode),
    [setControl],
  );
  const handleBrowserClose = useCallback(() => void closeBrowser(), [closeBrowser]);
  const handleBrowserBack = useCallback(() => void sendInput({ type: "back" }), [sendInput]);
  const handleBrowserForward = useCallback(
    () => void sendInput({ type: "forward" }),
    [sendInput],
  );
  const handleBrowserReload = useCallback(
    () => void sendInput({ type: "reload" }),
    [sendInput],
  );
  const handleBrowserNavigate = useCallback(
    (url: string) => void sendInput({ type: "navigate", url }),
    [sendInput],
  );
  // Header click opens the panel. If the AI asked for help (attention state),
  // the user opening it means they're stepping in → take control for them.
  const browserAttention = !!browserSession?.takeoverReason;
  const handleBrowserHeaderOpen = useCallback(() => {
    openBrowserPanel();
    if (browserAttention && browserSession?.controlMode !== "user") {
      void setControl("user");
    }
  }, [openBrowserPanel, browserAttention, browserSession?.controlMode, setControl]);

  // One BrowserView element reused by whichever layout is active (split column
  // or drawer — they're mutually exclusive, so only one renders).
  const browserViewEl = browserSession ? (
    <BrowserView
      liveViewUrl={browserSession.liveViewUrl}
      sessionId={browserSession.sessionKey}
      controlMode={browserSession.controlMode}
      iframeReloadKey={iframeReloadKey}
      viewport={browserSession.viewport}
      currentUrl={browserSession.currentUrl}
      onControlChange={handleBrowserControlChange}
      onUserInputTap={handleUserInputTap}
      onUserInputText={handleUserInputText}
      onUserInputKey={handleUserInputKey}
      onUserInputScroll={handleUserInputScroll}
      onBack={handleBrowserBack}
      onForward={handleBrowserForward}
      onReload={handleBrowserReload}
      onNavigate={handleBrowserNavigate}
      onCollapse={closeBrowserPanel}
      onRequestClose={handleBrowserClose}
    />
  ) : null;

  return {
    browserSessionKey,
    browserSession,
    browserPanelOpen,
    browserLayout,
    canSplitBrowser,
    browserAttention,
    browserViewEl,
    closeBrowserPanel,
    handleBrowserHeaderOpen,
  };
}
