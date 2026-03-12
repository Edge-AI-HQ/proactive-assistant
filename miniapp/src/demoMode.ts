/**
 * Demo mode utilities for miniapp
 * Allows the app to run in a regular browser without Telegram WebApp context
 */

export const isDemoMode = (): boolean => {
  // Check if running outside Telegram (PC browser / web preview mode)
  if (typeof window === "undefined") return false;

  // If Telegram WebApp is not available or has no initData, we're in web preview mode
  const hasTelegramWebApp = Boolean(window.Telegram?.WebApp);
  const hasInitData = Boolean(window.Telegram?.WebApp?.initData?.trim());

  return hasTelegramWebApp && !hasInitData;
};

export const setupDemoMode = (): void => {
  if (!isDemoMode()) return;

  console.log("[Web Mode] Initializing web environment");

  // Mock Telegram WebApp API
  if (!window.Telegram) {
    window.Telegram = {};
  }

  if (!window.Telegram?.WebApp) {
    const mockWebApp = {
      ready: () => {
        console.log("[WebApp] ready() called");
      },
      expand: () => {
        console.log("[WebApp] expand() called");
      },
      requestFullscreen: () => {
        console.log("[WebApp] requestFullscreen() called");
      },
      close: () => {
        console.log("[WebApp] close() called");
      },
      platform: "web",
      initData: "",
      initDataUnsafe: {},
      openLink: (
        url: string,
        options?: { try_instant_view?: boolean; try_browser?: string },
      ) => {
        console.log("[WebApp] openLink() called:", url, options);
        window.open(url, "_blank", "noopener,noreferrer");
      },
      openTelegramLink: (url: string) => {
        console.log("[WebApp] openTelegramLink() called:", url);
        window.open(url, "_blank", "noopener,noreferrer");
      },
    };

    window.Telegram.WebApp = mockWebApp as any;
  }

  // Web mode runs without visual indicators
};

/**
 * Get the bootstrap endpoint based on mode
 */
export const getBootstrapEndpoint = (): string => {
  const initData = window.Telegram?.WebApp?.initData?.trim() ?? "";
  // Use preview endpoint if no initData (web preview mode)
  return initData ? "/api/mini/bootstrap" : "/api/mini/bootstrap-demo";
};

/**
 * Get init data for bootstrap
 * In web preview mode (no initData), returns empty object (server uses preview user)
 * In Telegram mode, returns actual initData
 */
export const getBootstrapPayload = (): { init_data?: string } => {
  const initData = window.Telegram?.WebApp?.initData?.trim() ?? "";
  return initData ? { init_data: initData } : {};
};
