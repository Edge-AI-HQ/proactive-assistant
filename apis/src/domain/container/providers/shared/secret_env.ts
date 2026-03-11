const BASE_FORBIDDEN_SECRET_ENV_KEYS = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ELEVENLABS_API_KEY',
  'XI_API_KEY',
  'BRAVE_API_KEY',
  // NOTE: OPENCLAW_GATEWAY_TOKEN is intentionally NOT in this list.
  // It is a per-user gateway token (not a platform-level P0 secret) and
  // must be injected into the container for plugin auto-pairing to work.
] as const;

export const DOCKER_FORBIDDEN_SECRET_ENV_KEYS = [...BASE_FORBIDDEN_SECRET_ENV_KEYS] as const;
export const FLY_FORBIDDEN_SECRET_ENV_KEYS = [...BASE_FORBIDDEN_SECRET_ENV_KEYS, 'OPENCLAW_CONFIG_JSON'] as const;
