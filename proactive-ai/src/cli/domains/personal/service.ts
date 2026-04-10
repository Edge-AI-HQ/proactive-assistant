import { callCore } from "../../output/adapter.js";
import { personal as corePersonal } from "../../../core/index.js";
import type { CliRuntimeInput, RunCliResult } from "../../runtime.js";
import type { PersonalProvider } from "../../../core/index.js";

export const setup = async (
  runtime: CliRuntimeInput,
  input: { key: string },
): Promise<RunCliResult> =>
  callCore("personal", "setup", () => corePersonal.setup(runtime, input));

export const status = async (
  runtime: CliRuntimeInput,
): Promise<RunCliResult> =>
  callCore("personal", "status", () => corePersonal.status(runtime));

export const listConnections = async (
  runtime: CliRuntimeInput,
  input?: { toolkits?: string },
  deps?: { provider?: PersonalProvider },
): Promise<RunCliResult> =>
  callCore("personal", "connections list", () =>
    corePersonal.listConnections(runtime, input, deps),
  );

export const connectApp = async (
  runtime: CliRuntimeInput,
  input: { toolkit: string },
  deps?: { provider?: PersonalProvider },
): Promise<RunCliResult> =>
  callCore("personal", "connect", () =>
    corePersonal.connectApp(runtime, input, deps),
  );

export const waitForConnection = async (
  runtime: CliRuntimeInput,
  input: { toolkit: string },
  deps?: { provider?: PersonalProvider },
): Promise<RunCliResult> =>
  callCore("personal", "wait", () =>
    corePersonal.waitForConnection(runtime, input, deps),
  );

export const searchTools = async (
  runtime: CliRuntimeInput,
  input: { query: string; toolkit?: string; limit?: string },
  deps?: { provider?: PersonalProvider },
): Promise<RunCliResult> =>
  callCore("personal", "tools search", () =>
    corePersonal.searchTools(runtime, input, deps),
  );

export const getToolSchema = async (
  runtime: CliRuntimeInput,
  input: { name: string },
  deps?: { provider?: PersonalProvider },
): Promise<RunCliResult> =>
  callCore("personal", "tools schema", () =>
    corePersonal.getToolSchema(runtime, input, deps),
  );

export const execTool = async (
  runtime: CliRuntimeInput,
  input: { tool: string; input?: string; accountId?: string },
  deps?: { provider?: PersonalProvider },
): Promise<RunCliResult> =>
  callCore("personal", "exec", () =>
    corePersonal.execTool(runtime, { tool: input.tool, input: input.input, connectedAccountId: input.accountId }, deps),
  );
