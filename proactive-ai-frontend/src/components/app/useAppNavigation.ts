import { useCallback, useRef, useState } from "react";
import type { IntentCard } from "@pin-ai/core";
import type { LiveSession } from "@/services/ambient/live-session";
import type { ChatCard } from "@/components/chat/ChatDetailView";

/** Single source of truth for the 6 top-level views. SideMenu's
 *  MENU_ITEMS must stay in this same order (locked by the menu test). */
export type MenuId =
  | "now" | "ambient" | "chat" | "connect" | "profile" | "account";

export type SettingsSubPage =
  | "main" | "subscription" | "preferences" | "notifications" | "ambient";

const ACTIVE_VIEW_KEY = "pai-active-view";
const SUBPAGE_KEY = "pai-account-subpage";

function readSession<T extends string>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  return (window.sessionStorage.getItem(key) as T | null) ?? fallback;
}

export interface AppNavigation {
  // ── state (full-screen layers only; bottom-sheet drawers stay in
  //    AppLayout because their Intent type isn't exported) ──
  activeView: MenuId;
  menuOpen: boolean;
  chatTarget: { card: IntentCard; bootstrap?: string } | null;
  activeChat: ChatCard | null;
  mainChatOpen: boolean;
  liveOverlay: LiveSession | null;
  settingsSubPage: SettingsSubPage;
  // ── actions ──
  navigateTo: (id: MenuId) => void;
  setMenuOpen: (open: boolean) => void;
  openCardChat: (card: IntentCard, bootstrap?: string) => void;
  closeCardChat: () => void;
  setActiveChat: (c: ChatCard | null) => void;
  openMainChat: () => void;
  closeMainChat: () => void;
  /** Raw setter — kept so the Escape-key handler can close main chat
   *  WITHOUT the closeMainChat() side-effect of forcing activeView="now". */
  setMainChatOpen: (open: boolean) => void;
  setLiveOverlay: (s: LiveSession | null) => void;
  setSettingsSubPage: (p: SettingsSubPage) => void;
  recordChatEntryView: () => void;
  /** Close the topmost open full-screen layer. Returns true if consumed.
   *  Bottom-sheet drawers (card detail / paywall) are intentionally NOT
   *  handled here — they own their own vaul dismiss gesture and their
   *  overlay sits above the edge hit-zone, so the swipe never reaches us. */
  goBack: () => boolean;
}

export function useAppNavigation(): AppNavigation {
  const [activeView, setActiveViewState] = useState<MenuId>(
    () => readSession<MenuId>(ACTIVE_VIEW_KEY, "now"),
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const [chatTarget, setChatTarget] = useState<
    { card: IntentCard; bootstrap?: string } | null
  >(null);
  const [activeChat, setActiveChat] = useState<ChatCard | null>(null);
  const [mainChatOpen, setMainChatOpen] = useState(false);
  const [liveOverlay, setLiveOverlay] = useState<LiveSession | null>(null);
  const [settingsSubPage, setSettingsSubPageState] = useState<SettingsSubPage>(
    () => readSession<SettingsSubPage>(SUBPAGE_KEY, "main"),
  );
  const chatEntryView = useRef<MenuId | null>(null);

  const setActiveView = useCallback((v: MenuId) => {
    setActiveViewState(v);
    if (typeof window !== "undefined") {
      window.sessionStorage.setItem(ACTIVE_VIEW_KEY, v);
    }
  }, []);

  const setSettingsSubPage = useCallback((p: SettingsSubPage) => {
    setSettingsSubPageState(p);
    if (typeof window !== "undefined") {
      window.sessionStorage.setItem(SUBPAGE_KEY, p);
    }
  }, []);

  const navigateTo = useCallback((id: MenuId) => {
    setActiveView(id);
    setActiveChat(null);
    setChatTarget(null);
    setMenuOpen(false);
    // Re-enter Setting at its top level: a stale sub-page (e.g. Ambient) must
    // not resurface when navigating into Setting from another view. Harmless
    // for non-account targets since the sub-page only renders under "account".
    setSettingsSubPage("main");
  }, [setActiveView, setSettingsSubPage]);

  const recordChatEntryView = useCallback(() => {
    chatEntryView.current = activeView;
  }, [activeView]);

  const openCardChat = useCallback((card: IntentCard, bootstrap?: string) => {
    chatEntryView.current = activeView;
    setChatTarget({ card, bootstrap });
  }, [activeView]);

  const closeCardChat = useCallback(() => {
    const returnTo = chatEntryView.current;
    setChatTarget(null);
    setActiveChat(null);
    if (returnTo) setActiveView(returnTo);
  }, [setActiveView]);

  const openMainChat = useCallback(() => setMainChatOpen(true), []);
  const closeMainChat = useCallback(() => {
    setActiveView("now");
    setMainChatOpen(false);
  }, [setActiveView]);

  const goBack = useCallback((): boolean => {
    if (liveOverlay) { setLiveOverlay(null); return true; }
    if (mainChatOpen) { closeMainChat(); return true; }
    if (menuOpen) { setMenuOpen(false); return true; }
    if (chatTarget || activeChat) { closeCardChat(); return true; }
    if (activeView === "account" && settingsSubPage !== "main") {
      setSettingsSubPage("main");
      return true;
    }
    return false;
  }, [
    liveOverlay, mainChatOpen, menuOpen, chatTarget, activeChat,
    activeView, settingsSubPage, closeMainChat, closeCardChat,
    setSettingsSubPage,
  ]);

  return {
    activeView, menuOpen, chatTarget, activeChat, mainChatOpen, liveOverlay,
    settingsSubPage,
    navigateTo, setMenuOpen, openCardChat, closeCardChat, setActiveChat,
    openMainChat, closeMainChat, setMainChatOpen, setLiveOverlay,
    setSettingsSubPage, recordChatEntryView, goBack,
  };
}
