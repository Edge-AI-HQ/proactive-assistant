// @pin-ai/ui-web — web 介质共享层（React DOM 组件 + 平台 hooks），
// proactive-ai-frontend（Capacitor 壳）与 apps/web（zebra 桌面壳）双端共用。
// 依赖硬标准 =「纯 web 环境可运行」；重 native 模块禁止进入（见 package.json
// description 与 docs/plans/2026-06-12-zebra-web-app-port.mdx）。
//
// 注意：import 本包即触发 transport-bootstrap 的 configureTransport side
// effect（与 frontend 旧 `@/lib/api` shim 的「模块加载即配置」语义一致）。

export const PIN_AI_UI_WEB = "@pin-ai/ui-web";

// ── i18n：共享 UI 国际化（react-i18next）。import 本包即初始化 i18next（en
//    静态打包为回落层，其余 7 语言懒加载），与 transport-bootstrap 同样的
//    「模块加载即配置」side effect。语言真源 = settings.generationLanguage，
//    经 useUiLanguageSync 驱动；同一设置在后端 lang_clause 控制 LLM 输出语言。
import "./i18n";
export { default as i18n, loadAndSwitchLanguage } from "./i18n";
export {
  detectDeviceLanguage,
  matchSupportedLanguage,
  SUPPORTED_UI_LANGUAGES,
} from "./i18n/languages";
export { useUiLanguageSync } from "./i18n/use-ui-language-sync";

// ── primitives：设计系统基础组件（契约在 @pin-ai/ui-kit，此为 web 实现） ──
export { Text } from "./primitives/Text";
export { Button } from "./primitives/Button";
export { Input } from "./primitives/Input";
export { Surface } from "./primitives/Surface";
export { Box } from "./primitives/Box";
export { Stack, VStack, HStack, Spacer } from "./primitives/Stack";
export { Divider } from "./primitives/Divider";
export { Icon } from "./primitives/Icon";

// ── auth：supabase client / 平台判定 / dev auth / OAuth hook / transport 注入 ──
export { supabase } from "./auth/supabase";
export { isNative, isElectron, PIN_API_BASE, pinApiRequestHeaders } from "./auth/platform";
export { getDesktopBridge, type PinaiDesktopBridge } from "./auth/desktop-bridge";
export {
  isPinLocalDevAuthEnabled,
  pinLocalDevAuthHeaders,
  pinLocalDevAuthSession,
  pinLocalDevAuthUser,
  PIN_LOCAL_DEV_AUTH_HEADER_VALUE,
  PIN_LOCAL_DEV_AUTH_USER_ID,
  PIN_LOCAL_DEV_AUTH_EMAIL,
} from "./auth/dev-auth";
export { registerSignOutCleanup } from "./auth/auth-cleanup";
export { useAuth } from "./auth/useAuth";
export { initialOAuthError } from "./auth/supabase";
export { authHeaders, profileClientHintHeaders } from "./auth/transport-bootstrap";

// ── card：展示原语 / detail 面板内容 / 卡动作 hook ──
export {
  brandSvg,
  detectToolIcon,
  ToolIconBadge,
  matchSideEffect,
  ArtifactItem,
  type ToolIcon,
  type Artifact,
  type ChatCard,
} from "./card/chat-card-presentation";
export {
  DrawerDetailBody,
  HowGeneratedSection,
  executeArtifactToLovable,
  type DrawerDetailCard,
} from "./card/CardDrawerBody";
export { sourceAppDisplay, reasoningStepLabel, type SourceAppDisplay } from "./card/source-app-display";
export { cardThreadSessionKey, buildCardContext, CardContextHeaderSlot } from "./card/card-chat";
export { basketMeta, type BasketMeta } from "./card/basket-meta";
export { useCardActions, type UseCardActionsOptions } from "./card/useCardActions";
export { registerFeedbackOutbox, type FeedbackOutbox } from "./card/feedback-outbox";

// ── now：球面 / 卡片视觉模型 / 天气 ──
// card-model 的 Artifact / ExecutionStep 不出 barrel（与 chat-card-presentation
// 的 Artifact、@pin-ai/core 的 ExecutionStep 同名不同源），按需走深路径。
export { default as Sphere3DCards, getSphereCardPresentation, computeCardStyle, type Sphere3DCardItem, type SphereCardStatus } from "./now/Sphere3DCards";
export {
  djb2,
  basketToLovableCategory,
  realIntentToChatCard,
  realCardToLovableIntent,
  CATEGORIES,
  categoryLabel,
  type Intent,
  type CardStatus,
  type DetailData,
} from "./now/card-model";
export { useWeather, type WeatherData } from "./now/useWeather";

// ── chat：conversation 全栈（main chat / card chat 共用的对话面） ──
export { default as ConversationView } from "./chat/conversation/ConversationView";
export { default as MinimalistLanding } from "./chat/conversation/MinimalistLanding";

// ── voice：语音输入（getUserMedia + 流式转写；ambient 麦克风互斥经注册点） ──
export {
  VoiceProvider,
  useVoiceInput,
  VoiceButton,
  appendVoiceTranscript,
  Waveform,
  BrowserSpeechEngine,
  ByteDanceStreamingEngine,
  GptTranscriptionEngine,
  type VoiceButtonProps,
  type VoiceEngine,
  type VoiceEngineHandle,
  type VoiceEngineCallbacks,
  type StartCaptureOptions,
  type VoiceContextValue,
  type VoiceProviderProps,
} from "./voice";
export { registerExternalMicAcquirer, type ExternalMicLease } from "./voice/external-mic-bridge";
export { createPcmRecorder, createPcmStreamRecorder, type PcmRecorder, type PcmStreamRecorder } from "./voice/pcm-recorder";
export { transcribeVoiceAudio, type TranscribeVoiceAudioOptions } from "./voice/transcription-api";
export { normalizeVoiceLanguage, type VoiceLanguageHint } from "./voice/language";

// ── browser：browser tool 的远程画面面板 ──
export { default as BrowserView } from "./browser/BrowserView";
export { default as BrowserHeader } from "./browser/BrowserHeader";
export { default as BrowserDrawer } from "./browser/BrowserDrawer";
export {
  useBrowserSession,
  type BrowserControlMode,
  type BrowserDeviceKind,
  type BrowserSession,
  type BrowserInput,
  type UseBrowserSessionResult,
} from "./browser/useBrowserSession";

// ── now：AiSphere（视频水晶球；sphere.webm/mp4 资产在各 app public/） ──
export { default as AiSphere, type AiSphereProps } from "./now/AiSphere";

// ── 本地同步引擎注入点（native/Electron 注册；纯 web 不注册=纯网络路径） ──
export {
  registerLocalThreadStore,
  notifyThreadActivity,
  readLocalHistory,
  type LocalThreadStore,
} from "./local-sync";

// ── connect：Composio 状态 hook / connector 卡 OAuth / toolkit 图标 ──
export { ConnectChip } from "./connect/ConnectChip";
// useComposio（React hook）已移 @pin-ai/state（跨端 hooks 层，RN 也复用）——
// 消费者直接 import @pin-ai/state，ui-web 不再转出。纯逻辑（buildConnector*
// / normalizeComposioToolkit / Composio* types）真源在 @pin-ai/core。
export {
  isConnectorCard,
  connectorSlugFromIntentKey,
  canonicalConnectorSlugFromIntentKey,
  triggerConnectorOAuth,
  prepareConnectorOAuth,
  openPreparedConnectorOAuth,
  tryHandleConnectorCard,
  type PreparedConnectorOAuth,
} from "./connect/connector-card";
export { openOAuthAndAwaitClose, closeOAuthSurface, PopupBlockedError } from "./connect/oauth-popup";
export { getToolkit, type ToolkitMeta } from "./connect/toolkit-icons";

// ── connect：CONNECT 视图功能件（Composio 连接矩阵 / device registry / 上传数据 timeline） ──
export { default as ControlPanel } from "./connect/ControlPanel";
// onboarding connector 洞察卡（iOS OnboardingFlow + apps/web ZebraOnboarding 共用）。
export { default as ConnectorOnboardingInsight, type ConnectorInsightStatus } from "./connect/ConnectorOnboardingInsight";
export {
  default as DataConnections,
  INPUT_CATEGORIES,
  RECOMMENDED_SOURCES,
  isDataSourceConnected,
  type DataSource,
  type InputCategory,
} from "./connect/DataConnections";
export { default as DeviceConnections } from "./connect/DeviceConnections";
export { default as DeviceTimeline } from "./connect/DeviceTimeline";
// useInitTask（React hook）已移 @pin-ai/state（跨端 hooks 层）——消费者直接
// import @pin-ai/state，ui-web 不再转出。
export {
  extractComposioDisplayIdentity,
  formatComposioToolkitName,
  resolveComposioConnectionIdentity,
  formatComposioConnectionIdentity,
  formatOptionalComposioConnectionIdentity,
  type ComposioIdentityConnection,
} from "./connect/composio-display-identity";
// device-timeline-filters 已移 @pin-ai/core（纯日期逻辑，跨端）——消费者直接
// import @pin-ai/core，ui-web 不再转出。

// ── profile：MIRROR 共享展示层（apps/web MirrorDesktop + proactive
//    MirrorMobile 复用；数据走 @pin-ai/state 的 useProfileSnapshot /
//    useProfileMemories；各 app 的 layout shell 自己持 tab/openGroups/expandedGoal）。──
export {
  ProfilePanel,
  MemoryPanel,
  GoalsGrid,
  GoalDetail,
  IdentitySummaryCard,
  WorkbenchTabButton,
  type ProfileGroupKey,
} from "./profile/mirror";

// ── account：SETTING sections + 订阅（真实 Stripe 链路） ──
export { default as AutoDreamingSettings } from "./account/AutoDreamingSettings";
export { default as AutoGenerateSettings } from "./account/AutoGenerateSettings";
export { default as GenerationLanguageSettings } from "./account/GenerationLanguageSettings";
export { default as ScheduledTasksSettings } from "./account/ScheduledTasksSettings";
export { PlanPaymentForm, PLANS, isPayValid, type PlanId, type PayMethod, type CardInfo } from "./account/PlanPaymentForm";
export { default as PaywallDrawer } from "./account/PaywallDrawer";
export { SubscriptionPanel, SubPageHeader } from "./account/SubscriptionPanel";

// ── ui：vaul drawer 包装（移动 bottom-sheet；桌面也可用） ──
export {
  Drawer,
  DrawerPortal,
  DrawerOverlay,
  DrawerTrigger,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerFooter,
  DrawerTitle,
  DrawerDescription,
} from "./ui/drawer";

// ── debug：开发调试面板（pipeline run / generate / skills / memories /
//    crystallize）。支持可选受控（open/onOpenChange/hideTrigger）：iOS 不传=
//    自管+自带 gear，apps/web sidebar 传受控+自画 debug icon。 ──
export { default as DebugPanel } from "./debug/DebugPanel";
