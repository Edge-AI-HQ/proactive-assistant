export type UnknownRecord = Record<string, unknown>;

export interface FlyVolume {
  id: string;
  name: string;
  state?: string;
  host_status?: string;
  region?: string;
  created_at?: string;
  attached_machine_id?: string | null;
}

export interface FlyMachine {
  id: string;
  name?: string;
  region?: string;
  state?: string;
  private_ip?: string;
  created_at?: string;
  updated_at?: string;
  config?: {
    image?: string;
    env?: Record<string, string>;
    init?: {
      exec?: string[];
    };
    guest?: {
      cpus?: number;
      memory_mb?: number;
    };
    mounts?: Array<{
      volume: string;
      path: string;
    }>;
    restart?: {
      policy?: string;
      max_retries?: number;
    };
  };
}
