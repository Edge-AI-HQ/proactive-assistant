/**
 * Preload script — exposes a safe IPC bridge to the renderer.
 *
 * The renderer (Proactive AI UI) can call window.electronAPI.* to
 * interact with the Electron main process for settings management.
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // API Key management
  getApiKeyStatus: () => ipcRenderer.invoke('config:apikey:status'),
  saveApiKey: (provider: string, key: string) => ipcRenderer.invoke('config:apikey:save', provider, key),
  notifyApiKeySaved: () => ipcRenderer.send('config:apikey:saved'),
});
