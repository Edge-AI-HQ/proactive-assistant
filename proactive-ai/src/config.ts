export interface ProactiveAIConfig {
  max_iterations: number;
  agent_timeout_ms: number;
}

export const DEFAULT_CONFIG: ProactiveAIConfig = {
  max_iterations: 2,
  agent_timeout_ms: 300_000,
};
