// @pin-ai/state — 跨端 React hooks 层（react-only，无 react-dom），
// web / Electron renderer / Expo RN 三端共用。
// 架构与边界规则见 research/2026-06-10-frontend-layering.mdx §3-§4。
//
// queries/*：TQ 域 hooks（分层 Phase 2 从 proactive-ai-frontend hooks/ 迁入；
//            迁移模式见 queries/memories.ts 头注释）。
// QueryClient 由各端入口创建并提供 Provider —— 本包只消费 context。

export const PIN_AI_STATE = "@pin-ai/state";

export {
  agentRunsKeys,
  useActiveAgentRuns,
  useAgentRunSuccess,
  type UseActiveAgentRunsState,
} from "./queries/agent-runs";
export {
  useCardExecutionRun,
  type UseCardExecutionRun,
  type UseCardExecutionRunOptions,
} from "./queries/card-execution";
export {
  cardsKeys,
  useCardsQuery,
  type UseCardsQueryResult,
} from "./queries/cards";
export {
  weatherKeys,
  useWeatherData,
} from "./queries/weather";
export {
  useBrowserSession,
  type UseBrowserSessionResult,
} from "./queries/browser-session";
export {
  useConversationRuntime,
  type ConversationRuntimeOpts,
  type UseConversationRuntimeResult,
} from "./queries/conversation";
export {
  finalizePlanTurn,
  parseTodosFromArgs,
  setTodos,
  useTodoPlan,
  type Todo,
  type TodoPlan,
} from "./stores/todos";
export {
  memoriesKeys,
  useMemories,
  type UseMemoriesResult,
} from "./queries/memories";
export {
  usePipeline,
  type PipelinePersist,
  type UsePipelineOptions,
} from "./queries/pipeline";
export {
  skillsKeys,
  useSkills,
  type UseSkillsFilter,
  type UseSkillsResult,
} from "./queries/skills";
export {
  userDevicesKeys,
  useUserDevices,
  type UseUserDevicesApi,
} from "./queries/user-devices";
export {
  userSettingsKeys,
  useUserSettings,
  type AmbientSourceConsent,
  type UserSettings,
  type UserSettingsPatch,
  type UseUserSettingsResult,
} from "./queries/user-settings";
export {
  useComposio,
  buildConnectorInitTaskId,
  buildConnectorPreviewTaskId,
  normalizeComposioToolkit,
  composioToolkitCovers,
  getComposioConnectionsForToolkit,
  isComposioToolkitConnected,
  type ComposioState,
  type ComposioStatus,
  type Connection,
  type ComposioCatalogItem,
  type ComposioCatalogPage,
  type ComposioCustomAuthScheme,
  type ComposioCustomAuthConfig,
  type ConnectToolkitOptions,
  type CustomMcpConnector,
  type CustomMcpConnectorResult,
} from "./queries/composio";
export {
  useCrystallize,
  type UseCrystallizeResult,
} from "./queries/crystallize";
export {
  useInitTask,
  isInitTaskFresh,
  type InitTaskRow,
  type UseInitTaskState,
  type TaskStatus,
} from "./queries/init-task";
