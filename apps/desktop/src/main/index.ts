/**
 * Electron main process —— 桌面壳的全部原生职责：
 *   1. 窗口生命周期（macOS hiddenInset 标题栏，关窗不退出）；
 *   2. OAuth 回调：renderer 起跳前经 IPC 起一次性 loopback HTTP server
 *      （127.0.0.1:52271，RFC 8252 模式），回调转发 renderer 完成 PKCE
 *      code exchange。`ai.pin.proactive.desktop://` scheme 管道（open-url /
 *      second-instance → renderer）保留给打包版的 app 深链，OAuth 不依赖；
 *   3. 打包模式用 privileged scheme `pinai://desktop` 服 renderer 静态文件
 *      ——fetch 的 Origin 是稳定的 `pinai://desktop`，后端 CORS allowlist
 *      照 capacitor://localhost 模式登记（file:// 的 Origin 是 "null"，
 *      进 allowlist 等于对所有 sandboxed 页面开门，不可用）；
 *   4. 外链一律 shell.openExternal，窗口内只导航自己的 origin；
 *   5. 同步引擎桌面 driver：node:sqlite（Electron 36 内置 Node 22，FTS5
 *      可用，零 native 依赖）持 per-user 库于 userData/sync/，renderer 经
 *      IPC 跑 SQL（与 Capacitor driver 同构：显式 BEGIN/COMMIT + 调用方
 *      全局串行）；
 *   6. 常驻形态：关窗驻留（hide 而非销毁，renderer 的同步/通知继续跑）、
 *      tray、全局快捷键 Cmd+Shift+Space 唤起。
 *
 * 安全基线：contextIsolation on（默认）、nodeIntegration off、sandbox on；
 * renderer 能力只经 preload 的 contextBridge 白名单暴露。
 */
import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  net,
  protocol,
  shell,
  Tray,
} from "electron";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const OAUTH_SCHEME = "ai.pin.proactive.desktop";
// OAuth 回调的 loopback 端口（VS Code 模式）。固定值——Supabase Redirect
// URLs 是精确 allowlist，随机端口没法登记。被占时 listen 失败，错误经
// renderer console 可见。
const OAUTH_LOOPBACK_PORT = 52271;
const APP_SCHEME = "pinai";
const APP_ORIGIN = `${APP_SCHEME}://desktop`;
const RENDERER_DIR = path.join(__dirname, "../renderer");

let mainWindow: BrowserWindow | null = null;
// OAuth 内嵌登录窗（独立轻量窗口，回调到达即关）。
let oauthWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
// 关窗驻留：close 默认 hide；只有显式退出（Cmd+Q / tray Quit）才真关。
let isQuitting = false;
// deep link 可能在窗口就绪前到达（冷启动 via OAuth 回跳）——缓存补发。
let pendingDeepLink: string | null = null;

function deliverDeepLink(url: string): void {
  if (!url.startsWith(`${OAUTH_SCHEME}://`)) return;
  // 日志脱敏:只打 path,不打 query(含 OAuth code)。
  console.log(`[deep-link] received ${url.split("?")[0]}`);
  if (mainWindow && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send("pinai:open-url", url);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  } else {
    pendingDeepLink = url;
  }
}

// privileged scheme 必须在 app ready 前注册。
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

// OAuth scheme 注册。dev（未打包）模式 macOS 要求带 execPath+argv，
// 否则系统把回跳投给打包版/不投递。
if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient(OAUTH_SCHEME, process.execPath, [
    path.resolve(process.argv[1]),
  ]);
} else {
  app.setAsDefaultProtocolClient(OAUTH_SCHEME);
}

// 单实例：Win/Linux 的 deep link 以 second-instance argv 到达。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const url = argv.find((a) => a.startsWith(`${OAUTH_SCHEME}://`));
    if (url) deliverDeepLink(url);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// macOS 的 deep link 路径。ready 前后都可能触发。
app.on("open-url", (event, url) => {
  event.preventDefault();
  deliverDeepLink(url);
});

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: "#f6f4f0",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      sandbox: true,
    },
  });

  // 外链（OAuth 起跳、卡片里的 web 链接）开系统浏览器，窗口内不开新窗。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const dev = process.env.ELECTRON_RENDERER_URL;
    const internal = dev ? url.startsWith(dev) : url.startsWith(APP_ORIGIN);
    if (!internal) {
      event.preventDefault();
      if (url.startsWith("https://")) void shell.openExternal(url);
    }
  });

  mainWindow.webContents.on("did-finish-load", () => {
    if (pendingDeepLink && mainWindow) {
      mainWindow.webContents.send("pinai:open-url", pendingDeepLink);
      pendingDeepLink = null;
    }
  });

  // 常驻：关窗只是 hide——renderer 活着，同步引擎与新卡通知继续跑。
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    // dev:renderer console 转发到 make macos 的终端,排查 auth/同步链路
    // 不用开 devtools。warn/error 全转;info 级只转结构化日志（"[sync]"
    // 等前缀），避免淹没终端。
    mainWindow.webContents.on("console-message", (event) => {
      const structured = event.message.startsWith("[");
      if (event.level === "warning" || event.level === "error" || structured) {
        console.log(`[renderer:${event.level}] ${event.message}`);
      }
    });
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadURL(`${APP_ORIGIN}/index.html`);
  }
}

void app.whenReady().then(() => {
  // 打包模式：pinai://desktop/<path> → out/renderer/<path>，目录穿越拒之。
  protocol.handle(APP_SCHEME, (request) => {
    const { pathname } = new URL(request.url);
    const rel = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
    const target = path.join(RENDERER_DIR, rel);
    if (!target.startsWith(RENDERER_DIR)) {
      return new Response("forbidden", { status: 403 });
    }
    return net.fetch(pathToFileURL(target).toString());
  });

  // OAuth loopback：renderer 起跳前调用，起一次性 HTTP server 接 Supabase
  // 的 302 回调（dev/打包统一通道——macOS dev 模式未打包时 Launch Services
  // 的 scheme 注册不可靠，deep link 可能投不到本进程；scheme 管道保留给
  // 打包版的 app 深链）。收到回调即转发 renderer 并关停。
  let loopbackServer: http.Server | null = null;
  ipcMain.handle("pinai:oauth-loopback", () => {
    loopbackServer?.close();
    loopbackServer = null;
    return new Promise<number>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const reqUrl = req.url ?? "/";
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        // window.close() 只在 tab history 长度为 1 时被 Chrome 允许（已有
        // Google session、全程 302 直通的回头客场景）。走了多步登录页的
        // tab 关不掉——这是浏览器安全规则（VS Code/Slack 桌面登录同样留
        // tab），此时这个页面就是用户看到的完成态，做成品牌化成功页。
        res.end(
          '<!doctype html><html><head><meta charset="utf-8"><title>PIN AI</title></head>' +
            '<body style="margin:0;display:flex;align-items:center;justify-content:center;' +
            'height:100vh;background:#f6f4f0;font-family:system-ui,-apple-system,sans-serif">' +
            '<div style="text-align:center;max-width:360px;padding:24px">' +
            '<div style="width:56px;height:56px;margin:0 auto 16px;border-radius:50%;' +
            'background:#1a1a1a;color:#fff;font-size:28px;line-height:56px">&#10003;</div>' +
            '<h1 style="font-size:20px;margin:0 0 8px;color:#1a1a1a;font-weight:600">Signed in to PIN AI</h1>' +
            '<p style="color:#71717a;font-size:14px;margin:0;line-height:1.5">' +
            "You're back in the app. This tab will close itself if it can &mdash; " +
            "otherwise it's safe to close.</p>" +
            "</div>" +
            "<script>setTimeout(()=>window.close(),60);setTimeout(()=>window.close(),500)</script>" +
            "</body></html>",
        );
        if (reqUrl.includes("auth/callback")) {
          console.log("[oauth-loopback] callback received");
          mainWindow?.webContents.send(
            "pinai:open-url",
            `http://127.0.0.1:${OAUTH_LOOPBACK_PORT}${reqUrl}`,
          );
          // 内嵌登录窗模式：回调即达，登录窗使命完成，直接关闭。
          oauthWindow?.close();
          oauthWindow = null;
          if (mainWindow?.isMinimized()) mainWindow.restore();
          mainWindow?.focus();
          app.focus({ steal: true });
          server.close();
          if (loopbackServer === server) loopbackServer = null;
        }
      });
      server.on("error", (err) => {
        console.error("[oauth-loopback] listen failed:", err.message);
        reject(err);
      });
      server.listen(OAUTH_LOOPBACK_PORT, "127.0.0.1", () => {
        console.log(`[oauth-loopback] listening on ${OAUTH_LOOPBACK_PORT}`);
        resolve(OAUTH_LOOPBACK_PORT);
      });
      loopbackServer = server;
      // 用户中途放弃登录时别让端口悬挂。
      setTimeout(() => {
        if (loopbackServer === server) {
          server.close();
          loopbackServer = null;
        }
      }, 180_000).unref();
    });
  });

  // OAuth 内嵌登录窗：独立轻量 BrowserWindow 加载 Google/Supabase 登录页，
  // 回调到达 loopback 即由上面的 handler 关闭。Google 政策禁 embedded
  // webview（UA 检测）——去掉 UA 里的 Electron/app 标记呈现为标准 Chrome
  // （业界常见的灰色做法；密码管理器不可用是其代价）。`persist:oauth`
  // 分区记住 Google 登录态：之后的登录窗口一闪即关，近乎无感。若未来
  // Google 强化检测，回退 openExternal（系统浏览器）即可。
  ipcMain.handle("pinai:oauth-window", (_event, url: unknown) => {
    if (typeof url !== "string" || !url.startsWith("https://")) return;
    oauthWindow?.close();
    const win = new BrowserWindow({
      width: 480,
      height: 720,
      parent: mainWindow ?? undefined,
      title: "Sign in — PIN AI",
      autoHideMenuBar: true,
      webPreferences: { partition: "persist:oauth", sandbox: true },
    });
    win.webContents.userAgent = win.webContents.userAgent
      .split(" ")
      .filter((seg) => !seg.startsWith("Electron/") && !seg.toLowerCase().includes("pin-ai"))
      .join(" ");
    // 登录页内的外链（条款/帮助）开系统浏览器，登录窗不长出新窗。
    win.webContents.setWindowOpenHandler(({ url: u }) => {
      if (u.startsWith("https://")) void shell.openExternal(u);
      return { action: "deny" };
    });
    win.on("closed", () => {
      if (oauthWindow === win) oauthWindow = null;
    });
    oauthWindow = win;
    void win.loadURL(url);
  });

  // ── 同步引擎桌面 driver：per-user node:sqlite 库（userData/sync/）。
  // dbName 白名单 + 路径固定目录防穿越；SQL 来自我们自己的 renderer
  // （sandbox + contextIsolation 下的第一方代码），与 Capacitor driver
  // 的信任面一致。事务语义：renderer 侧显式 BEGIN/COMMIT（单连接 +
  // sync-bootstrap 全局串行，与 capacitor-database.ts 同构）。
  const syncDbDir = path.join(app.getPath("userData"), "sync");
  const syncDbs = new Map<string, DatabaseSync>();
  const syncDb = (name: unknown): DatabaseSync => {
    if (typeof name !== "string" || !/^pinai_sync_[A-Za-z0-9_]+$/.test(name)) {
      throw new Error("invalid sync db name");
    }
    let db = syncDbs.get(name);
    if (!db) {
      fs.mkdirSync(syncDbDir, { recursive: true });
      db = new DatabaseSync(path.join(syncDbDir, `${name}.db`));
      syncDbs.set(name, db);
    }
    return db;
  };
  ipcMain.handle("pinai:db-run", (_event, name: unknown, sql: unknown, params: unknown) => {
    syncDb(name)
      .prepare(String(sql))
      .run(...((params as (string | number | null)[] | undefined) ?? []));
  });
  ipcMain.handle("pinai:db-query", (_event, name: unknown, sql: unknown, params: unknown) =>
    syncDb(name)
      .prepare(String(sql))
      .all(...((params as (string | number | null)[] | undefined) ?? [])),
  );

  // 通知点击/快捷键唤起。
  const showMainWindow = () => {
    if (!mainWindow) {
      createWindow();
      return;
    }
    mainWindow.show();
    mainWindow.focus();
    app.focus({ steal: true });
  };
  ipcMain.handle("pinai:show-window", () => showMainWindow());

  // ── tray + 全局快捷键 ──
  const trayIconPath = app.isPackaged
    ? path.join(process.resourcesPath, "tray-icon.png")
    : path.join(__dirname, "../../resources/tray-icon.png");
  const trayIcon = nativeImage
    .createFromPath(trayIconPath)
    .resize({ width: 18, height: 18 });
  tray = new Tray(trayIcon);
  tray.setToolTip("PIN AI");
  const toggleWindow = () => {
    if (mainWindow?.isVisible() && mainWindow.isFocused()) mainWindow.hide();
    else showMainWindow();
  };
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open PIN AI", click: showMainWindow },
      { type: "separator" },
      {
        label: "Quit PIN AI",
        accelerator: "Command+Q",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("click", toggleWindow);

  if (!globalShortcut.register("CommandOrControl+Shift+Space", toggleWindow)) {
    console.warn("[shortcut] Cmd+Shift+Space already taken by another app");
  }

  ipcMain.handle("pinai:open-external", (_event, url: unknown) => {
    if (typeof url === "string" && (url.startsWith("https://") || url.startsWith("http://"))) {
      return shell.openExternal(url);
    }
    return Promise.resolve();
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

// macOS 惯例：关窗驻留 dock/tray，Cmd+Q 才退出。
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
