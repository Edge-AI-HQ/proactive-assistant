// Proactive AI domain types
// Uses the unified `users` + `runtime_instances` tables from migrations 001-016.

/** Row from the `users` table (relevant columns for proactive auth). */
export interface ProactiveUser {
  id: number;                     // BIGSERIAL PK
  supabase_user_id: string;       // UUID = auth.users.id
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
  auth_provider: string | null;   // 'google', 'microsoft', etc.
  gateway_token: string;
  created_at: string;
  updated_at: string;
  last_active_at: string;
}

/** Row from the `runtime_instances` table (scope = 'user'). */
export interface ProactiveContainer {
  id: number;                     // BIGSERIAL PK
  owner_user_id: number;
  scope: 'user';
  runtime_provider: 'fly' | 'docker';
  container_name: string;
  runtime_ref: string | null;
  host_port: number;
  status: 'creating' | 'running' | 'stopped' | 'suspended' | 'error' | 'idle' | 'missing';
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  last_active_at: string | null;
}

export interface ProactiveContainerParams {
  userId: string;           // Supabase UUID (used for naming)
  internalUserId: number;   // users.id BIGINT (used for DB FK)
  containerName: string;
  gatewayToken: string;
  litellmApiKey: string | null;
}

export interface ProactiveAuthPayload {
  userId: string;           // Supabase UUID (from JWT sub)
  email: string;
  name?: string | undefined;
  avatarUrl?: string | undefined;
}
