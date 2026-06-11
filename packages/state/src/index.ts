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
  cardsKeys,
  useCardsQuery,
  type UseCardsQueryResult,
} from "./queries/cards";
export {
  memoriesKeys,
  useMemories,
  type UseMemoriesResult,
} from "./queries/memories";
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
