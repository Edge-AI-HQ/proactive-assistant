import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { errorEnvelope, okEnvelope } from "../../output/envelope.js";
import { ErrorType } from "../../output/errors.js";
import type { CliRuntimeInput, RunCliResult } from "../../runtime.js";
import {
  createPersonalProvider,
  type PersonalProvider,
} from "./provider.js";
import { loadPlatformSettings } from "./platform_settings.js";

// ── Key persistence ──

const KEY_FILENAME = "composio-consumer-key";

function keyFileCandidates(homeDir: string): string[] {
  const cliDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  return [
    resolve(cliDir, "..", "proactive-ai", KEY_FILENAME),
    resolve(homeDir, ".openclaw", "plugins", "proactive-ai", KEY_FILENAME),
  ];
}

export function loadConsumerKey(homeDir: string): string {
  for (const path of keyFileCandidates(homeDir)) {
    try {
      const key = readFileSync(path, "utf-8").trim();
      if (key) return key;
    } catch { /* next */ }
  }
  return "";
}

function saveConsumerKey(homeDir: string, key: string): string {
  const candidates = keyFileCandidates(homeDir);
  for (const path of candidates) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, key, { mode: 0o600 });
      return path;
    } catch { /* next */ }
  }
  throw new Error(`Cannot write consumer key to any of: ${candidates.join(", ")}`);
}

// ── Error helpers ──

const providerUnavailable = (command: string, message: string): RunCliResult => ({
  exitCode: 1,
  stdout: errorEnvelope(
    "personal", command,
    ErrorType.PROVIDER_UNAVAILABLE, "PROVIDER_NOT_CONFIGURED",
    message,
    "set COMPOSIO_API_KEY for platform mode, or run `pin personal setup --key ck_...` for legacy consumer-key mode",
  ),
});

const wrapProviderError = (command: string, error: unknown): RunCliResult => {
  const message = error instanceof Error ? error.message : "Unknown provider error";
  if (message.includes("COMPOSIO_CONSUMER_KEY") || message.includes("COMPOSIO_API_KEY")) {
    return providerUnavailable(command, message);
  }
  return {
    exitCode: 1,
    stdout: errorEnvelope(
      "personal", command,
      ErrorType.PROVIDER_UNAVAILABLE, "PROVIDER_ERROR",
      message, "check consumer key and network connectivity",
    ),
  };
};

// ── Commands ──

export const setup = async (
  runtime: CliRuntimeInput,
  input: { key: string },
): Promise<RunCliResult> => {
  const key = input.key.trim();

  if (!key || !key.startsWith("ck_")) {
    return {
      exitCode: 2,
      stdout: errorEnvelope(
        "personal", "setup",
        ErrorType.VALIDATION, "INVALID_ARGUMENT",
        key ? "Consumer key must start with 'ck_'" : "Consumer key is empty",
        "get your key from https://dashboard.composio.dev",
      ),
    };
  }

  let savedPath: string;
  try {
    savedPath = saveConsumerKey(runtime.homeDir, key);
  } catch (err) {
    return {
      exitCode: 1,
      stdout: errorEnvelope(
        "personal", "setup",
        ErrorType.INTERNAL, "SAVE_FAILED",
        err instanceof Error ? err.message : String(err),
        "check file permissions",
      ),
    };
  }

  // Validate by discovering connections
  try {
    const provider = createPersonalProvider(
      { ...runtime, env: { ...runtime.env, COMPOSIO_CONSUMER_KEY: key } },
    );
    await provider.discoverConnections();
  } catch {
    try { writeFileSync(savedPath, "", { mode: 0o600 }); } catch { /* best effort */ }
    return {
      exitCode: 1,
      stdout: errorEnvelope(
        "personal", "setup",
        ErrorType.PROVIDER_UNAVAILABLE, "INVALID_KEY",
        "Consumer key validation failed — could not connect to Composio MCP",
        "verify your key at https://dashboard.composio.dev",
      ),
    };
  }

  return {
    exitCode: 0,
    stdout: okEnvelope("personal", "setup", {
      saved: true,
      path: savedPath,
      keyPrefix: key.slice(0, 6) + "...",
    }),
  };
};

export const status = async (
  runtime: CliRuntimeInput,
): Promise<RunCliResult> => {
  const platformSettings = loadPlatformSettings(runtime.homeDir);
  const apiKey = runtime.env.COMPOSIO_API_KEY?.trim() || platformSettings.apiKey || "";
  const consumerKey = runtime.env.COMPOSIO_CONSUMER_KEY || loadConsumerKey(runtime.homeDir);
  return {
    exitCode: 0,
    stdout: okEnvelope("personal", "status", {
      configured: !!apiKey || !!consumerKey,
      mode: apiKey ? "platform" : (consumerKey ? "consumer" : "none"),
      source: apiKey
        ? (runtime.env.COMPOSIO_API_KEY ? "platform-env" : "platform-file")
        : (runtime.env.COMPOSIO_CONSUMER_KEY ? "env" : (consumerKey ? "file" : "none")),
      keyPrefix: apiKey
        ? apiKey.slice(0, 6) + "..."
        : (consumerKey ? consumerKey.slice(0, 6) + "..." : null),
    }),
  };
};

export const listConnections = async (
  runtime: CliRuntimeInput,
  input?: { toolkits?: string },
  deps?: { provider?: PersonalProvider },
): Promise<RunCliResult> => {
  try {
    const provider = createPersonalProvider(runtime, deps?.provider);

    // If specific toolkits requested, check those; otherwise discover via broad search
    const toolkitList = input?.toolkits
      ? input.toolkits.split(",").map(t => t.trim()).filter(Boolean)
      : null;

    const connections = toolkitList
      ? await provider.checkConnections(toolkitList)
      : await provider.discoverConnections();

    return {
      exitCode: 0,
      stdout: okEnvelope("personal", "connections list", connections),
    };
  } catch (error) {
    return wrapProviderError("connections list", error);
  }
};

export const connectApp = async (
  runtime: CliRuntimeInput,
  input: { toolkit: string },
  deps?: { provider?: PersonalProvider },
): Promise<RunCliResult> => {
  try {
    const provider = createPersonalProvider(runtime, deps?.provider);
    const conn = await provider.connectApp(input.toolkit);
    return { exitCode: 0, stdout: okEnvelope("personal", "connect", conn) };
  } catch (error) {
    return wrapProviderError("connect", error);
  }
};

export const waitForConnection = async (
  runtime: CliRuntimeInput,
  input: { toolkit: string },
  deps?: { provider?: PersonalProvider },
): Promise<RunCliResult> => {
  try {
    const provider = createPersonalProvider(runtime, deps?.provider);
    const conn = await provider.waitForConnection(input.toolkit);
    return { exitCode: 0, stdout: okEnvelope("personal", "wait", conn) };
  } catch (error) {
    return wrapProviderError("wait", error);
  }
};

export const searchTools = async (
  runtime: CliRuntimeInput,
  input: { query: string; toolkit?: string; limit?: string },
  deps?: { provider?: PersonalProvider },
): Promise<RunCliResult> => {
  try {
    const provider = createPersonalProvider(runtime, deps?.provider);
    const limit = input.limit ? parseInt(input.limit, 10) : 20;
    const tools = await provider.searchTools(input.query, {
      toolkit: input.toolkit,
      limit: Number.isNaN(limit) ? 20 : limit,
    });
    return {
      exitCode: 0,
      stdout: okEnvelope("personal", "tools search", {
        query: input.query,
        toolkit: input.toolkit ?? null,
        count: tools.length,
        tools,
      }),
    };
  } catch (error) {
    return wrapProviderError("tools search", error);
  }
};

export const getToolSchema = async (
  runtime: CliRuntimeInput,
  input: { name: string },
  deps?: { provider?: PersonalProvider },
): Promise<RunCliResult> => {
  try {
    const provider = createPersonalProvider(runtime, deps?.provider);
    const schema = await provider.getToolSchema(input.name);
    if (!schema) {
      return {
        exitCode: 1,
        stdout: errorEnvelope(
          "personal", "tools schema",
          ErrorType.NOT_FOUND, "TOOL_NOT_FOUND",
          `Tool ${input.name} not found`,
          "run `pin personal tools search --query <keyword>` to discover available tools",
        ),
      };
    }
    return { exitCode: 0, stdout: okEnvelope("personal", "tools schema", schema) };
  } catch (error) {
    return wrapProviderError("tools schema", error);
  }
};

const parseJsonInput = (raw: string): Record<string, unknown> => {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--input must be a JSON object");
  }
  return parsed as Record<string, unknown>;
};

export const execTool = async (
  runtime: CliRuntimeInput,
  input: { tool: string; input?: string },
  deps?: { provider?: PersonalProvider },
): Promise<RunCliResult> => {
  let args: Record<string, unknown> = {};
  if (input.input) {
    try {
      args = parseJsonInput(input.input);
    } catch (error) {
      return {
        exitCode: 2,
        stdout: errorEnvelope(
          "personal", "exec",
          ErrorType.VALIDATION, "INVALID_ARGUMENT",
          error instanceof Error ? error.message : "Invalid JSON input",
          "pass a valid JSON object, e.g. --input '{\"query\":\"test\",\"max_results\":5}'",
        ),
      };
    }
  }

  try {
    const provider = createPersonalProvider(runtime, deps?.provider);
    const result = await provider.executeTool(input.tool, args);
    if (!result.success) {
      return {
        exitCode: 1,
        stdout: errorEnvelope(
          "personal", "exec",
          ErrorType.PROVIDER_UNAVAILABLE, "TOOL_EXECUTION_FAILED",
          result.error ?? "Tool execution failed",
          `check tool schema with \`pin personal tools schema --name ${input.tool}\``,
        ),
      };
    }
    return {
      exitCode: 0,
      stdout: okEnvelope("personal", "exec", { tool: result.tool, data: result.data }),
    };
  } catch (error) {
    return wrapProviderError("exec", error);
  }
};
