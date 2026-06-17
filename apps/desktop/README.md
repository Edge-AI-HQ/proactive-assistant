# PIN AI Desktop（Electron macOS 壳）

「一套 zebra UI、web + 桌面两个壳」：renderer 直接复用 `apps/web` 的
Vite root（index.html + src/，apps/web 是 UI 真源），桌面侧只有 main process + preload 两个文件。
设计 SSOT：`research/2026-06-10-frontend-layering.mdx` §3.2 / §5。

## 本地开发

```bash
make macos          # 连本 worktree 的 compose 后端（自动解密 env + 抓随机端口）
make macos DEV=1    # 连 fly dev
make macos PROD=1   # 连 fly prod（连 Supabase 也切 prod 的）
```

- `/api` 走 dev server 同源 proxy（`changeOrigin`，本地/fly 都通）——与
  web dev 完全一致，零 CORS。
- web UI 改动即热更（renderer 就是 apps/web 的源码）。
- 不走 make 的裸启动：`set -a && . pinai-agents/.env && set +a &&
  VITE_PIN_API_PROXY_TARGET=<url> npm run dev --workspace=@pin-ai/desktop`。

## OAuth（PKCE + 内嵌登录窗 + localhost loopback）

点 Sign in 弹**独立轻量登录窗**（480×720 子 BrowserWindow，`persist:oauth`
分区），用户在窗内完成 Google 登录，Supabase 302 到
`http://127.0.0.1:52271/auth/callback?code=...`——main process 起跳前开的
一次性 loopback server 收到回调：转发 renderer `exchangeCodeForSession`、
**关闭登录窗**、把主窗抢回前台。PKCE verifier 在 renderer 的
localStorage，发起与交换同端完成。`persist:oauth` 记住 Google 登录态，
之后的登录窗一闪即关，近乎无感。

已知 trade-off：Google 政策禁 embedded webview（UA 检测），登录窗 UA 已
去掉 Electron/app 标记（业界常见灰色做法）；代价是浏览器密码管理器不可
用，首次需手输。若未来 Google 强化检测，`useAuth` 里把
`openOauthWindow` 换回 `openExternal`（系统浏览器 + 同一 loopback 管道）
即可。

选 loopback 不选 scheme deep link 的原因：macOS dev 模式（未打包、无
Info.plist）下 Launch Services 的 scheme 注册不保证把 URL 投给本进程
（实测复现）。scheme 管道（`open-url` → preload bridge）保留给打包版的
app 深链。

**一次性配置（每个 Supabase 项目）**：Dashboard → Authentication → URL
Configuration → Redirect URLs 加 `http://127.0.0.1:52271/auth/callback`。

## 打包（后续刀，配置已就位）

```bash
cd apps/desktop && npm run package   # electron-vite build + electron-builder dmg
```

- 打包件用 privileged scheme `pinai://desktop` 服 renderer 静态文件——
  fetch 的 Origin 稳定为 `pinai://desktop`，**后端 `CORS_ALLOWED_ORIGINS`
  需加这一项**（照 `capacitor://localhost` 模式，dotenvx 改各环境 env）。
- 打包构建需设 `VITE_PIN_API_URL`（无同源后端，同 Capacitor 要求）。
- 签名/公证/自动更新未配——分发前的工作。

## 桌面产品能力（第二刀已落地）

- **同步引擎 driver**：main process 持 `node:sqlite`（Electron 36 内置
  Node 22，FTS5 可用，零 native 依赖），per-user 库在
  `userData/sync/pinai_sync_<uid>.db`；renderer 经 preload 的
  `dbRun`/`dbQuery` IPC 跑 SQL，事务与 Capacitor driver 同构（显式
  BEGIN/COMMIT + sync-bootstrap 全局串行）。桌面端由此获得 #103 全部能力：
  历史秒开、离线可读、feedback outbox、FTS 索引。
- **新卡系统通知**：事件源 = `syncCards().newCardIds`（相对本地镜像的
  增量，bootstrap 轮不算新）；web Notification API 自动桥 macOS 通知
  中心，点击唤起主窗。
- **常驻形态**：关窗驻留（hide 而非销毁——renderer 的同步与通知后台
  继续跑）、menu bar tray（Open / Quit）、全局快捷键 `Cmd+Shift+Space`
  切换窗口；Cmd+Q / tray Quit 才真退出。

## 边界

- renderer 的桌面能力只经 preload 白名单（`window.pinaiDesktop`）；
  contextIsolation + sandbox 开；db IPC 的 dbName 白名单 + 固定目录防
  穿越。
- 后续刀：Cmd+K 本地全文搜索 UI（FTS 已就绪）、打包签名/公证、CSP。
