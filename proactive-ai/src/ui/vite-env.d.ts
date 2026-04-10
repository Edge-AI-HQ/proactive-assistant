/// <reference types="vite/client" />

/** IPC bridge exposed by electron/preload.ts via contextBridge */
interface ElectronAPI {
  getApiKeyStatus(): Promise<{ provider: string; hasKey: boolean }>;
  saveApiKey(provider: string, key: string): Promise<{ saved: boolean; error?: string }>;
  notifyApiKeySaved(): void;
  notifyReady(): void;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
