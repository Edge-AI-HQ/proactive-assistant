# PIN AI Mobile（Expo RN / iOS）

Capacitor → React Native 迁移的 app 壳（分层方案 §1 拍板：RN UI 独立实现，
业务层 100% 复用 `@pin-ai/core` + `@pin-ai/state`）。**第一刀范围**：登录
（PKCE + ASWebAuthenticationSession）+ main chat（流式 SSE，复用
`useConversationRuntime`）+ 同步引擎（expo-sqlite driver + core
SyncScheduler）。

## 本地开发（simulator）

```bash
make rn          # 默认：你的 iPhone + 本 worktree compose 后端（同 make ios 工作流：make reset && make up && make rn）
make rn SIM=1    # simulator（127.0.0.1 直达）
make rn DEV=1    # 连 fly dev
make rn PROD=1   # 连 fly prod（连 Supabase 一起切）
```

真机默认档自动探测连接的 iPhone（USB/WiFi 调试），本地后端走 Mac 的
LAN IP（手机需与 Mac 同 WiFi）。

首次会 `expo prebuild`（CNG：`ios/` 是生成产物，gitignore）+ pod install +
xcodebuild，之后增量秒级。裸启动：source `backend/.env` 后把 `VITE_*`
映射到 `EXPO_PUBLIC_*` 再 `npm run ios --workspace=@pin-ai/mobile`。

## 复用结构（「新端只写壳」的 RN 实证）

| 层 | 来源 | RN 侧文件 |
|---|---|---|
| SSE/transport/API/状态机 | `@pin-ai/core`（共用） | `lib/transport-bootstrap.ts`（注入 `expo/fetch`——RN 内置 fetch 无 ReadableStream，这是调研标记的硬雷） |
| conversation 运行时 | `@pin-ai/state`（共用） | `screens/ChatScreen.tsx` 只有 FlatList 渲染 + composer |
| 同步调度器 | `@pin-ai/core` `createSyncScheduler`（共用） | `lib/sync/expo-database.ts`（driver ~60 行）+ 薄壳 |
| auth | supabase-js PKCE | `hooks/useAuth.ts`（openAuthSessionAsync，scheme 复用 Capacitor 时代的 Supabase Redirect 条目，零新增配置） |

入口 polyfill（`index.ts`）：URL（supabase 依赖）、TextDecoder（SSE 解码）、
WebCrypto digest（expo-crypto——否则 supabase PKCE 降级
`code_challenge_method=plain`）。

## bundle id / scheme

`ai.pin.proactive.development`（= 现 Capacitor dev app）：RN app 是它的
继任者，同设备安装即覆盖更新，OAuth scheme 与 Supabase 配置零迁移。prod
（`ai.pin.proactive`）等功能对齐后由 CI 注入（同 build-ios.sh 模式）。

## Ambient 采集迁移判定表（逐源：RN 直替 vs Swift 保留）

原则：RN/Expo 生态能覆盖的不用 Swift；覆盖不了的保留 Swift 换壳 Expo
Module。对照 `capacitor-plugins/ambient-ai`（Swift 8144 行）+
`services/ambient/sources/`（12 源）：

| 源 / 能力 | 原实现 | 判定 | 状态 |
|---|---|---|---|
| location（含反地理编码） | @capacitor/geolocation + Swift GeocodeService(327) | **RN 直替** expo-location（watch + reverseGeocode） | ✅ 已实现 |
| device-state（电量/低电量） | Capacitor API | **RN 直替** expo-battery | ✅ 已实现 |
| calendar（EventKit 扫描） | Capacitor 插件 | **RN 直替** expo-calendar | ✅ 已实现 |
| health（HealthKit） | @capgo/capacitor-health | **RN 直替** @kingstinct/react-native-healthkit（v14 Nitro） | ✅ 已实现 |
| motion-segments | 纯 TS 分段逻辑 | **共用**（随 normalize 管道） | 待接 |
| audio 采集 + VAD + 转写 | Swift | **Swift 保留 → Expo Module**（modules/ambient-audio，9 类原样迁移 + FluidAudio SPM） | ✅ 已迁移（分类/VAD 真机实证） |
| sound-classifier（SoundAnalysis 867） | Swift | **Swift 保留**（随 ambient-audio module） | ✅ 已迁移 |
| visit（CLVisitMonitor 521） | Swift | **Swift 保留 → Expo Module**（modules/ambient-visit，durable drain/ack 队列） | ✅ 已迁移 |
| activity（CMMotionActivity）/ focus | Swift 小件 | **Swift 保留**（并入 ambient-visit module） | ✅ 已迁移 |
| audio-route | 纯 JS（消费 audioState 路由字段） | **共用** | ✅ 已迁移 |
| 端上模型（Llama 引擎/下载器/Manifest ≈1474 行） | Swift | **删除**（曾迁入 `modules/ambient-models` 但 LlamaSwift 始终未接线；2026-07-11 随 on-device model sunset 整删，`AmbientAudioModule` 启动时幂等清理 `Documents/AmbientModels` 下载残留，见 docs/plans/2026-06-21-sunset-on-device-models.mdx） | 🗑 已删 |
| NearbyConnectivity（152 行） | Swift | **删除**（零 JS 消费的死代码） | 🗑 划掉 |

RN 侧管道（`src/ambient/`）：AmbientSource 接口/SIGNAL_KINDS/ingest wire
与 web 完全同协议（后端无感知客户端差异）；buffer 为内存级 MVP（durable
outbox 接 DatabasePort 是后续）；开关 = per-device 本地 opt-in（Me 页，
默认关，与 Capacitor 版隐私不变量一致）。

## UI 复刻状态（docs/plans/2026-06-12-rn-ui-parity.mdx）

刀 0-8 已落地：NativeWind 基建（packages/design token SSOT）、全局框架
（aurora/抽屉/页头/ASK PIN AI 上拉，无 bottom tab）、六页全量
（NOW 球面/TASKS/CONNECT/AMBIENT/PROFILE/SETTING 四子页）、chat 细节
（Thought 胶囊/操作行/composer）。

**视觉迭代清单（真机反馈驱动）**：
- 3D 球面手感细调（自转速度/拖拽阻尼/卡密度）
- AMBIENT 的 NARRATIVE SUMMARY 叙事卡（依赖 timeline 汇总管道 RN 落地）
- 消息级 thumbs 的后端上报端点接入
- Subscription plan 变更（dev 期走 web，上线前按审核政策定稿）
- TRIGGERED THIS CARD 信号→卡片联动链接

## 剩余工程刀

frontend 去 Capacitor 化 follow-up（删 services/ambient/sources/* 等
native 源 + capacitor-plugins/ 物理删除，见 README-RETIRED）；Android
（make rn 扩展）。
