// Ensure Electron runs in app mode, not Node mode.
// VS Code / Claude Code shells set ELECTRON_RUN_AS_NODE=1 which breaks everything.
delete process.env.ELECTRON_RUN_AS_NODE;

/**
 * Electron main process for Proactive AI desktop app.
 *
 * Flow:
 * 1. Register IPC handlers (config management)
 * 2. Show splash screen
 * 3. Resolve openclaw binary
 * 4. Run first-time setup if needed
 * 5. Check API key — prompt if missing
 * 6. Spawn openclaw gateway
 * 7. Load the Proactive AI UI
 *
 * Browser: OpenClaw manages its own Chrome window (visible, isolated profile).
 */

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { resolve } from 'node:path';
import { resolveOpenclawBin, startGateway, type GatewayHandle, type OpenclawBin } from './gateway';
import { needsSetup, runSetup, ensureConfig } from './setup';
import { getApiKeyStatus, saveApiKey, hasApiKey } from './config';
import { getPluginDir } from './paths';

const PLUGIN_DIR = getPluginDir();

let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let gateway: GatewayHandle | null = null;

// ── IPC handlers (config management) ──

ipcMain.handle('config:apikey:status', () => getApiKeyStatus());
ipcMain.handle('config:apikey:save', (_event, provider: string, key: string) => saveApiKey(provider, key));

// ── Single instance lock ──

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// ── App lifecycle ──

app.whenReady().then(async () => {
  showSplash();

  try {
    // 1. Find openclaw binary
    updateSplash('Looking for OpenClaw...');
    const openclawBin = resolveOpenclawBin();

    // 2. First-run setup + ensure config is current
    if (needsSetup(PLUGIN_DIR)) {
      updateSplash('Setting up for first run...');
      runSetup(PLUGIN_DIR);
    } else {
      ensureConfig();
    }

    // 3. Check API key — if missing, show setup window instead of gateway
    if (!hasApiKey()) {
      splashWindow?.destroy();
      splashWindow = null;
      showSetupWindow(openclawBin);
      return;
    }

    // 4. Start gateway and show main window
    await launchGatewayAndMainWindow(openclawBin);

  } catch (err) {
    splashWindow?.destroy();
    const message = err instanceof Error ? err.message : String(err);
    dialog.showErrorBox('Startup Failed', message);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (mainWindow === null && gateway) {
    mainWindow = createMainWindow();
    mainWindow.loadURL(`${gateway.url}/proactive-ai`);
  }
});

app.on('before-quit', async () => {
  if (gateway) {
    await gateway.kill();
    gateway = null;
  }
});

// ── Setup window (shown when API key is missing) ──

function showSetupWindow(openclawBin: OpenclawBin): void {
  const win = new BrowserWindow({
    width: 520,
    height: 420,
    resizable: false,
    title: 'Proactive AI — Setup',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0e17',
    webPreferences: {
      preload: resolve(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(SETUP_HTML)}`);

  ipcMain.once('config:apikey:saved', async () => {
    win.destroy();
    showSplash();
    try {
      await launchGatewayAndMainWindow(openclawBin);
    } catch (err) {
      splashWindow?.destroy();
      const message = err instanceof Error ? err.message : String(err);
      dialog.showErrorBox('Startup Failed', message);
      app.quit();
    }
  });
}

// ── Launch gateway + main window ──

async function launchGatewayAndMainWindow(openclawBin: OpenclawBin): Promise<void> {
  updateSplash('Starting AI engine...');
  gateway = await startGateway(openclawBin, PLUGIN_DIR);

  console.log(`[main] Gateway ready at ${gateway.url}`);
  console.log(`[main] Token: ${gateway.token.slice(0, 8)}...`);
  console.log(`[main] UI: ${gateway.url}/proactive-ai`);

  mainWindow = createMainWindow();
  mainWindow.loadURL(`${gateway.url}/proactive-ai`);

  // Inject a transparent drag region at the top of the page
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow?.webContents.insertCSS(`
      body::before {
        content: '';
        position: fixed;
        top: 0; left: 0; right: 0;
        height: 38px;
        -webkit-app-region: drag;
        z-index: 9999;
        pointer-events: none;
      }
      body::before { pointer-events: auto; }
      /* Buttons/links inside the drag zone must remain clickable */
      button, a, input, [role="button"] {
        -webkit-app-region: no-drag;
      }
    `);
  });

  mainWindow.once('ready-to-show', () => {
    splashWindow?.destroy();
    splashWindow = null;
    mainWindow?.show();
  });

  // Handle gateway crash
  let quitting = false;
  app.on('before-quit', () => { quitting = true; });
  gateway.process.on('exit', (code, signal) => {
    if (quitting) return;
    if (signal === 'SIGTERM' || signal === 'SIGKILL') return;
    if (code === 0) return;
    console.error(`[main] Gateway exited unexpectedly (code=${code}, signal=${signal})`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: 'Engine Stopped',
        message: 'The AI engine stopped unexpectedly. The app will restart it.',
        buttons: ['Restart', 'Quit'],
      }).then(({ response }) => {
        if (response === 0) {
          restartGateway(openclawBin);
        } else {
          app.quit();
        }
      });
    }
  });
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 448,
    height: 900,
    minWidth: 380,
    minHeight: 600,
    maxWidth: 520,
    title: 'Proactive AI',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0e17',
    show: false,
    webPreferences: {
      preload: resolve(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.on('closed', () => { mainWindow = null; });

  // Open external links (http/https) in the system default browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  return win;
}

// ── Splash screen ──

function showSplash(): void {
  splashWindow = new BrowserWindow({
    width: 400,
    height: 260,
    frame: false,
    resizable: false,
    transparent: true,
    alwaysOnTop: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  splashWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(SPLASH_HTML)}`);
}

function updateSplash(status: string): void {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.executeJavaScript(
      `document.getElementById('status').textContent = ${JSON.stringify(status)}`,
    ).catch(() => {});
  }
}

async function restartGateway(openclawBin: OpenclawBin): Promise<void> {
  try {
    gateway = await startGateway(openclawBin, PLUGIN_DIR);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(`${gateway.url}/proactive-ai`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    dialog.showErrorBox('Restart Failed', message);
    app.quit();
  }
}

// ── Setup HTML (API key entry, shown on first run) ──

const SETUP_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #0a0e17;
    color: #e2e8f0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100vh;
    padding: 40px;
    -webkit-app-region: drag;
  }
  .logo { font-size: 24px; font-weight: 700; margin-bottom: 4px; }
  .logo span { color: #06b6d4; }
  .subtitle { font-size: 13px; color: #64748b; margin-bottom: 32px; }
  .card {
    background: #111827;
    border: 1px solid #1e293b;
    border-radius: 16px;
    padding: 24px;
    width: 100%;
    max-width: 400px;
    -webkit-app-region: no-drag;
  }
  .label { font-size: 14px; font-weight: 500; margin-bottom: 8px; color: #94a3b8; }
  .hint { font-size: 12px; color: #64748b; margin-bottom: 16px; line-height: 1.5; }
  .hint a { color: #06b6d4; text-decoration: none; }
  .input-row { display: flex; gap: 8px; }
  input {
    flex: 1; padding: 10px 12px;
    background: #0a0e17; border: 1px solid #1e293b; border-radius: 8px;
    color: #e2e8f0; font-size: 13px;
    font-family: 'SF Mono', 'Fira Code', monospace;
    outline: none;
  }
  input:focus { border-color: #06b6d4; }
  button {
    padding: 10px 20px; border-radius: 8px; font-size: 13px; font-weight: 500;
    cursor: pointer; border: none; background: #06b6d4; color: white;
    transition: opacity 0.15s;
  }
  button:hover { opacity: 0.9; }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  #status { font-size: 12px; margin-top: 12px; min-height: 18px; }
  .error { color: #f87171; }
  .success { color: #34d399; }
</style>
</head>
<body>
  <div class="logo"><span>Proactive</span> AI</div>
  <div class="subtitle">First-time setup</div>
  <div class="card">
    <div class="label">Anthropic API Key</div>
    <div class="hint">
      Required to run AI agents. Get yours at
      <a href="https://console.anthropic.com/settings/keys" target="_blank">console.anthropic.com</a>
    </div>
    <div class="input-row">
      <input type="password" id="key-input" placeholder="sk-ant-...">
      <button id="save-btn">Save</button>
    </div>
    <div id="status"></div>
  </div>
  <script>
    const input = document.getElementById('key-input');
    const btn = document.getElementById('save-btn');
    const status = document.getElementById('status');

    btn.addEventListener('click', async () => {
      const key = input.value.trim();
      if (!key) return;
      btn.disabled = true;
      status.textContent = 'Saving...';
      status.className = '';
      try {
        const result = await window.electronAPI.saveApiKey('anthropic', key);
        if (result.saved) {
          status.textContent = 'Saved! Starting engine...';
          status.className = 'success';
          window.electronAPI.notifyApiKeySaved();
        } else {
          status.textContent = result.error || 'Save failed';
          status.className = 'error';
        }
      } catch (err) {
        status.textContent = err.message || 'Error';
        status.className = 'error';
      } finally {
        btn.disabled = false;
      }
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') btn.click();
    });
  </script>
</body>
</html>`;

// ── Splash HTML ──

const SPLASH_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #0a0e17;
    color: #e2e8f0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100vh;
    -webkit-app-region: drag;
    border-radius: 16px;
    border: 1px solid rgba(6, 182, 212, 0.2);
    overflow: hidden;
  }
  .logo { font-size: 28px; font-weight: 700; letter-spacing: -0.5px; margin-bottom: 8px; }
  .logo span { color: #06b6d4; }
  .subtitle { font-size: 13px; color: #64748b; margin-bottom: 32px; }
  .spinner {
    width: 32px; height: 32px;
    border: 3px solid rgba(6, 182, 212, 0.15);
    border-top-color: #06b6d4;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    margin-bottom: 16px;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  #status { font-size: 13px; color: #94a3b8; }
</style>
</head>
<body>
  <div class="logo"><span>Proactive</span> AI</div>
  <div class="subtitle">Personal Intelligence Engine</div>
  <div class="spinner"></div>
  <div id="status">Initializing...</div>
</body>
</html>`;
