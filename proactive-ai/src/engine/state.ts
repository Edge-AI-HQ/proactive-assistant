export interface PipelineState {
  running: boolean;
  phase: string | null;
  iteration: number | null;
}

interface AutoPollState {
  started: boolean;
  ingestTimer: ReturnType<typeof setInterval> | null;
  detectTimer: ReturnType<typeof setInterval> | null;
  ingestInFlight: boolean;
  loopInFlight: boolean;
}

interface ProactiveAiGlobal {
  state: PipelineState;
  autoPoll: AutoPollState;
  gatewayOrigin: string | null;
  initialized: boolean;
  profileSeeded: boolean;
}

const GLOBAL_KEY = '__proactiveAi__';
const g = globalThis as typeof globalThis & { [GLOBAL_KEY]?: ProactiveAiGlobal };

if (!g[GLOBAL_KEY]) {
  g[GLOBAL_KEY] = {
    state: { running: false, phase: null, iteration: null },
    autoPoll: {
      started: false,
      ingestTimer: null,
      detectTimer: null,
      ingestInFlight: false,
      loopInFlight: false,
    },
    gatewayOrigin: null,
    initialized: false,
    profileSeeded: false,
  };
}

export const shared = g[GLOBAL_KEY]!;
export const pipelineState = shared.state;
export const autoPollState = shared.autoPoll;
export const gatewayOriginState = shared;
