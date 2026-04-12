export interface ProactiveAIConfig {
  max_iterations: number;
  cards_per_iteration: number;
  agent_timeout_ms: number;
  auto_poll_enabled: boolean;
  auto_ingest_interval_ms: number;
  auto_detect_interval_ms: number;
  auto_loop_min_interval_ms: number;
  auto_process_min_age_ms: number;
  auto_poll_world_limit: number;
  auto_poll_profile_id: string;
  auto_poll_providers: string;
}

export const DEFAULT_CONFIG: ProactiveAIConfig = {
  max_iterations: 2,
  cards_per_iteration: 8,
  agent_timeout_ms: 300_000,
  auto_poll_enabled: true,
  auto_ingest_interval_ms: 300_000,
  auto_detect_interval_ms: 60_000,
  auto_loop_min_interval_ms: 900_000,
  auto_process_min_age_ms: 120_000,
  auto_poll_world_limit: 20,
  auto_poll_profile_id: 'default',
  auto_poll_providers: 'sec,fed,google-news',
};
