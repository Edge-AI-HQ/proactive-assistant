/**
 * Preload script — exposes a safe IPC bridge to the renderer.
 *
 * The renderer (Proactive AI UI) can call window.electronAPI.* to
 * interact with the Electron main process for settings management.
 */

import { contextBridge, ipcRenderer } from 'electron';

function readAdditionalArgument(prefix: string): string | undefined {
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  if (!match) return undefined;
  const value = match.slice(prefix.length);
  return value.length > 0 ? value : undefined;
}

const gatewayToken = readAdditionalArgument('--proactive-gw-token=');
const gatewayBaseUrl = readAdditionalArgument('--proactive-gw-url=');

if (gatewayToken) {
  contextBridge.exposeInMainWorld('__GW_TOKEN__', gatewayToken);
}

if (gatewayBaseUrl) {
  contextBridge.exposeInMainWorld('__GW_BASE_URL__', gatewayBaseUrl);
}

contextBridge.exposeInMainWorld('electronAPI', {
  // API Key management
  getApiKeyStatus: () => ipcRenderer.invoke('config:apikey:status'),
  saveApiKey: (provider: string, key: string) => ipcRenderer.invoke('config:apikey:save', provider, key),
  notifyApiKeySaved: () => ipcRenderer.send('config:apikey:saved'),
  notifyReady: () => ipcRenderer.send('ui:ready'),
});
