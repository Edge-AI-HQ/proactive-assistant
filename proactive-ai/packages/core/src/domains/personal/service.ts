import type { CoreContext } from "../../context.js";
import {
  ValidationError,
  NotFoundError,
  ProviderUnavailableError,
} from "../../errors.js";
import {
  createPersonalProvider,
  type PersonalProvider,
} from "./provider.js";
import { loadPlatformSettings } from "./platform_settings.js";

// ── Error helpers ──

const toProviderUnavailableError = (error: unknown): ProviderUnavailableError => {
  const message = error instanceof Error ? error.message : "Unknown provider error";
  if (message.includes("COMPOSIO_API_KEY")) {
    return new ProviderUnavailableError(
      "PROVIDER_NOT_CONFIGURED",
      message,
      "set COMPOSIO_API_KEY or configure it in ~/.openclaw-proactive-ai/local-settings.json",
    );
  }
  return new ProviderUnavailableError(
    "PROVIDER_ERROR",
    message,
    "check COMPOSIO_API_KEY and network connectivity",
  );
};

// ── Commands ──

export const setup = async (
  ctx: CoreContext,
  input: { key: string },
): Promise<{ validated: true; keyPrefix: string }> => {
  const key = input.key.trim();

  if (!key || !key.startsWith("ak_")) {
    throw new ValidationError(
      "INVALID_ARGUMENT",
      key ? "API key must start with 'ak_'" : "API key is empty",
      "get your key from https://dashboard.composio.dev",
    );
  }

  // Validate by discovering connections
  try {
    const provider = createPersonalProvider(
      { ...ctx, env: { ...ctx.env, COMPOSIO_API_KEY: key } },
    );
    await provider.discoverConnections();
  } catch {
    throw new ProviderUnavailableError(
      "INVALID_KEY",
      "API key validation failed — could not connect to Composio Platform API",
      "verify your key at https://dashboard.composio.dev",
    );
  }

  return {
    validated: true,
    keyPrefix: key.slice(0, 6) + "...",
  };
};

export const status = async (
  ctx: CoreContext,
): Promise<{
  configured: boolean;
  mode: string;
  source: string;
  keyPrefix: string | null;
}> => {
  const platformSettings = loadPlatformSettings(ctx.homeDir);
  const apiKey = ctx.env.COMPOSIO_API_KEY?.trim() || platformSettings.apiKey || "";
  return {
    configured: !!apiKey,
    mode: apiKey ? "platform" : "none",
    source: apiKey
      ? (ctx.env.COMPOSIO_API_KEY ? "platform-env" : "platform-file")
      : "none",
    keyPrefix: apiKey ? apiKey.slice(0, 6) + "..." : null,
  };
};

export const listConnections = async (
  ctx: CoreContext,
  input?: { toolkits?: string },
  deps?: { provider?: PersonalProvider },
): Promise<unknown[]> => {
  try {
    const provider = createPersonalProvider(ctx, deps?.provider);

    const toolkitList = input?.toolkits
      ? input.toolkits.split(",").map(t => t.trim()).filter(Boolean)
      : null;

    return toolkitList
      ? await provider.checkConnections(toolkitList)
      : await provider.discoverConnections();
  } catch (error) {
    throw toProviderUnavailableError(error);
  }
};

export const connectApp = async (
  ctx: CoreContext,
  input: { toolkit: string },
  deps?: { provider?: PersonalProvider },
): Promise<unknown> => {
  try {
    const provider = createPersonalProvider(ctx, deps?.provider);
    return await provider.connectApp(input.toolkit);
  } catch (error) {
    throw toProviderUnavailableError(error);
  }
};

export const waitForConnection = async (
  ctx: CoreContext,
  input: { toolkit: string },
  deps?: { provider?: PersonalProvider },
): Promise<unknown> => {
  try {
    const provider = createPersonalProvider(ctx, deps?.provider);
    return await provider.waitForConnection(input.toolkit);
  } catch (error) {
    throw toProviderUnavailableError(error);
  }
};

export const searchTools = async (
  ctx: CoreContext,
  input: { query: string; toolkit?: string; limit?: string },
  deps?: { provider?: PersonalProvider },
): Promise<{ query: string; toolkit: string | null; count: number; tools: unknown[] }> => {
  try {
    const provider = createPersonalProvider(ctx, deps?.provider);
    const limit = input.limit ? parseInt(input.limit, 10) : 20;
    const tools = await provider.searchTools(input.query, {
      toolkit: input.toolkit,
      limit: Number.isNaN(limit) ? 20 : limit,
    });
    return {
      query: input.query,
      toolkit: input.toolkit ?? null,
      count: tools.length,
      tools,
    };
  } catch (error) {
    throw toProviderUnavailableError(error);
  }
};

export const getToolSchema = async (
  ctx: CoreContext,
  input: { name: string },
  deps?: { provider?: PersonalProvider },
): Promise<unknown> => {
  try {
    const provider = createPersonalProvider(ctx, deps?.provider);
    const schema = await provider.getToolSchema(input.name);
    if (!schema) {
      throw new NotFoundError(
        "TOOL_NOT_FOUND",
        `Tool ${input.name} not found`,
        "run `pin personal tools search --query <keyword>` to discover available tools",
      );
    }
    return schema;
  } catch (error) {
    if (error instanceof NotFoundError) throw error;
    throw toProviderUnavailableError(error);
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
  ctx: CoreContext,
  input: { tool: string; input?: string },
  deps?: { provider?: PersonalProvider },
): Promise<{ tool: string; data: unknown }> => {
  let args: Record<string, unknown> = {};
  if (input.input) {
    try {
      args = parseJsonInput(input.input);
    } catch (error) {
      throw new ValidationError(
        "INVALID_ARGUMENT",
        error instanceof Error ? error.message : "Invalid JSON input",
        "pass a valid JSON object, e.g. --input '{\"query\":\"test\",\"max_results\":5}'",
      );
    }
  }

  try {
    const provider = createPersonalProvider(ctx, deps?.provider);
    const result = await provider.executeTool(input.tool, args);
    if (!result.success) {
      throw new ProviderUnavailableError(
        "TOOL_EXECUTION_FAILED",
        result.error ?? "Tool execution failed",
        `check tool schema with \`pin personal tools schema --name ${input.tool}\``,
      );
    }
    return { tool: result.tool, data: result.data };
  } catch (error) {
    if (error instanceof ProviderUnavailableError) throw error;
    throw toProviderUnavailableError(error);
  }
};
