import { callCore } from "../../output/adapter.js";
import { errorEnvelope, okEnvelope } from "../../output/envelope.js";
import { personal as corePersonal } from "../../../core/index.js";
import type { CliRuntimeInput, RunCliResult } from "../../runtime.js";
import type { PersonalProvider } from "../../../core/index.js";
import {
  claimMobileItems as claimLocalMobileItems,
  commitMobileItemRun as commitLocalMobileItemRun,
  listMobileItems as listLocalMobileItems,
} from "./mobile.js";

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

export const listMobileItems = async (
  runtime: CliRuntimeInput,
  input: { status?: string; type?: string; since?: string; until?: string; deviceId?: string; order?: string; limit?: string },
): Promise<RunCliResult> => {
  try {
    const items = listLocalMobileItems(runtime, {
      status: input.status,
      itemType: input.type,
      since: input.since,
      until: input.until,
      deviceId: input.deviceId,
      order: input.order,
      limit: input.limit ? Number.parseInt(input.limit, 10) : undefined,
    });
    return { exitCode: 0, stdout: okEnvelope("personal", "mobile.items.list", { items }) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exitCode: 1,
      stdout: errorEnvelope(
        "personal",
        "mobile.items.list",
        "runtime",
        "LOCAL_MOBILE_DB_UNAVAILABLE",
        message,
        "Set PIN_MOBILE_DB_PATH or run from a repo with data/proactive-*/mobile_items.db",
      ),
    };
  }
};

export const claimMobileItems = async (
  runtime: CliRuntimeInput,
  input: { type?: string; since?: string; until?: string; deviceId?: string; limit?: string },
): Promise<RunCliResult> => {
  try {
    const result = claimLocalMobileItems(runtime, {
      itemType: input.type,
      since: input.since,
      until: input.until,
      deviceId: input.deviceId,
      limit: input.limit ? Number.parseInt(input.limit, 10) : undefined,
    });
    return { exitCode: 0, stdout: okEnvelope("personal", "mobile.items.claim", result) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exitCode: 1,
      stdout: errorEnvelope(
        "personal",
        "mobile.items.claim",
        "runtime",
        "LOCAL_MOBILE_DB_UNAVAILABLE",
        message,
        "Set PIN_MOBILE_DB_PATH or run from a repo with data/proactive-*/mobile_items.db",
      ),
    };
  }
};

export const commitMobileItems = async (
  runtime: CliRuntimeInput,
  input: { runToken?: string },
): Promise<RunCliResult> => {
  if (!input.runToken?.trim()) {
    return {
      exitCode: 2,
      stdout: errorEnvelope(
        "personal",
        "mobile.items.commit",
        "validation",
        "INVALID_ARGUMENT",
        "Missing --run-token",
      ),
    };
  }

  try {
    const result = commitLocalMobileItemRun(runtime, input.runToken);
    return {
      exitCode: 0,
      stdout: okEnvelope("personal", "mobile.items.commit", { runToken: input.runToken, ...result }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exitCode: 1,
      stdout: errorEnvelope(
        "personal",
        "mobile.items.commit",
        "runtime",
        "LOCAL_MOBILE_DB_UNAVAILABLE",
        message,
        "Set PIN_MOBILE_DB_PATH or run from a repo with data/proactive-*/mobile_items.db",
      ),
    };
  }
};
