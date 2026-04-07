export interface PipelineState {
  running: boolean;
  phase: string | null;
  iteration: number | null;
}

interface ProactiveAiGlobal {
  state: PipelineState;
  initialized: boolean;
  profileSeeded: boolean;
}

const GLOBAL_KEY = '__proactiveAi__';
const g = globalThis as typeof globalThis & { [GLOBAL_KEY]?: ProactiveAiGlobal };

if (!g[GLOBAL_KEY]) {
  g[GLOBAL_KEY] = {
    state: { running: false, phase: null, iteration: null },
    initialized: false,
    profileSeeded: false,
  };
}

export const shared = g[GLOBAL_KEY]!;
export const pipelineState = shared.state;
