import { shouldBlockBrowserOpen, type PolicyToolCall } from './execution-policy.js';

interface RunPolicyContext {
  sessionKey: string;
  userMessage?: string;
  priorToolCalls: PolicyToolCall[];
}

interface BeforeToolCallEvent {
  toolName: string;
  params?: unknown;
  runId?: string;
  toolCallId?: string;
}

interface HookApi {
  logger?: {
    info?: (message: string) => void;
  };
  registerHook?: (
    hookName: 'before_tool_call',
    handler: (event: BeforeToolCallEvent, ctx?: unknown) => unknown,
    options?: { name?: string },
  ) => void;
}

const runPolicyContexts = new Map<string, RunPolicyContext>();

export function registerExecutionPolicyRunContext(input: {
  runId: string;
  sessionKey: string;
  userMessage?: string;
}): void {
  runPolicyContexts.set(input.runId, {
    sessionKey: input.sessionKey,
    userMessage: input.userMessage,
    priorToolCalls: [],
  });
}

export function clearExecutionPolicyRunContext(runId: string): void {
  runPolicyContexts.delete(runId);
}

export function getExecutionPolicyRunContextForTest(runId: string): RunPolicyContext | undefined {
  return runPolicyContexts.get(runId);
}

export function evaluateBeforeToolCallForExecutionPolicy(
  event: BeforeToolCallEvent,
  _ctx?: unknown,
): { block: boolean; blockReason?: string } {
  const runId = event.runId;
  const runContext = runId ? runPolicyContexts.get(runId) : undefined;
  if (!runContext) {
    return { block: false };
  }

  const decision = shouldBlockBrowserOpen({
    toolName: event.toolName,
    args: event.params,
    priorToolCalls: runContext.priorToolCalls,
    userMessage: runContext.userMessage,
  });

  runContext.priorToolCalls.push({
    name: event.toolName,
    args: event.params,
    blocked: decision.block,
  });

  if (!decision.block) {
    return { block: false };
  }

  return {
    block: true,
    blockReason: decision.reason ?? 'Blocked by proactive-ai execution policy.',
  };
}

let hooksRegistered = false;

export function registerExecutionPolicyHooks(api: HookApi): void {
  if (hooksRegistered || !api.registerHook) {
    return;
  }

  api.registerHook(
    'before_tool_call',
    (event, ctx) => {
      const result = evaluateBeforeToolCallForExecutionPolicy(event, ctx);
      if (result.block) {
        api.logger?.info?.(
          `[execution-policy] blocked toolName=${event.toolName} runId=${event.runId ?? 'unknown'} reason=${result.blockReason ?? 'unknown'}`,
        );
      }
      return result;
    },
    { name: 'proactive-ai-execution-policy' },
  );
  hooksRegistered = true;
}
