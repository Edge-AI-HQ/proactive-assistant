/**
 * Composio provider for personal data access.
 *
 * Uses Platform API keys (`ak_...`) to create Composio MCP sessions, then
 * routes data access through Composio MCP meta tools.
 */

import type { CoreContext } from "../../context.js";
import { loadPlatformSettings, loadOrCreateUserId } from "./platform_settings.js";

// ── Types ──

export interface PersonalConnection {
  toolkit: string;
  status: string;
  connectedAccountId: string | null;
  userInfo: Record<string, unknown> | null;
  redirectUrl: string | null;
}

export interface PersonalToolInfo {
  slug: string;
  description: string | null;
  toolkit: string | null;
}

export interface PersonalToolSchema {
  slug: string;
  description: string | null;
  parameters: Record<string, unknown>;
}

export interface PersonalExecResult {
  tool: string;
  success: boolean;
  data: unknown;
  error: string | null;
}

export interface PersonalProvider {
  /** Discover all connected accounts (multiple per toolkit allowed). */
  discoverConnections(): Promise<PersonalConnection[]>;
  /** Check specific toolkits' connection status (returns all accounts per toolkit). */
  checkConnections(toolkits: string[]): Promise<PersonalConnection[]>;
  /** Initiate a new OAuth connection for a toolkit. */
  connectApp(toolkit: string): Promise<PersonalConnection>;
  /** Wait for an OAuth connection to become active. */
  waitForConnection(toolkit: string): Promise<PersonalConnection>;
  /** Search tools by use case (returns tools + connection statuses). */
  searchTools(query: string, options?: { toolkit?: string; limit?: number }): Promise<PersonalToolInfo[]>;
  /** Get tool input schema. */
  getToolSchema(slug: string): Promise<PersonalToolSchema | null>;
  /** Execute a tool. If connectedAccountId is provided, pass it through to Composio. */
  executeTool(slug: string, args: Record<string, unknown>, connectedAccountId?: string): Promise<PersonalExecResult>;
  /** Disconnect (delete) a specific connected account by ID. */
  disconnectAccount(connectedAccountId: string): Promise<void>;
  /** Resolve human-readable identity for a connected account (best-effort). */
  resolveAccountIdentity(toolkit: string, connectedAccountId: string): Promise<Record<string, unknown> | null>;
}

// ── Helpers ──

const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SKIP_KEYS = /token|secret|key|password|code|cursor|etag|sync|url|endpoint|slug|status|type|version|id$/i;

/**
 * Extract a human-readable identity string from Composio's `current_user_info`.
 * Strategy: find the first email-shaped string, else the first short plain string.
 * Works across 1000+ Composio apps without per-app logic.
 */
export function extractIdentity(info: Record<string, unknown> | null | undefined): string | null {
  if (!info) return null;

  for (const v of Object.values(info)) {
    if (typeof v === "string" && EMAIL_RE.test(v)) return v;
  }

  for (const [k, v] of Object.entries(info)) {
    if (typeof v !== "string" || v.length === 0 || v.length > 60) continue;
    if (v.startsWith("http") || SKIP_KEYS.test(k)) continue;
    return v;
  }

  return null;
}

// ── Noop (no key configured) ──

class NoopPersonalProvider implements PersonalProvider {
  private fail(): never { throw new Error("COMPOSIO_API_KEY is not configured"); }
  async discoverConnections(): Promise<PersonalConnection[]> { return []; }
  async checkConnections(): Promise<PersonalConnection[]> { this.fail(); }
  async connectApp(): Promise<PersonalConnection> { this.fail(); }
  async waitForConnection(): Promise<PersonalConnection> { this.fail(); }
  async searchTools(): Promise<PersonalToolInfo[]> { this.fail(); }
  async getToolSchema(): Promise<PersonalToolSchema | null> { this.fail(); }
  async executeTool(): Promise<PersonalExecResult> { this.fail(); }
  async disconnectAccount(): Promise<void> { this.fail(); }
  async resolveAccountIdentity(): Promise<Record<string, unknown> | null> { this.fail(); }
}

const DEFAULT_API_BASE = "https://backend.composio.dev/api/v3";

const parseJson = async (response: Response): Promise<Record<string, unknown>> => {
  const text = await response.text();
  if (!text.trim()) return {};

  try {
    return obj(JSON.parse(text));
  } catch {
    throw new Error(`Invalid Composio JSON response: ${text.slice(0, 300)}`);
  }
};

async function composioApiCall(
  apiBase: string,
  apiKey: string,
  path: string,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      ...(init?.headers ?? {}),
    },
  });

  const json = await parseJson(response);
  if (!response.ok) {
    const message = str(json.message) ?? str(json.error) ?? JSON.stringify(json).slice(0, 300);
    throw new Error(`Composio API ${response.status}: ${message}`);
  }

  return json;
}

async function mcpCall(
  mcpUrl: string,
  apiKey: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const body = {
    jsonrpc: "2.0",
    id: Date.now().toString(),
    method,
    ...(params ? { params } : {}),
  };

  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Composio MCP ${res.status}: ${await res.text()}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const text = await res.text();
    for (const line of text.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const parsed = JSON.parse(line.slice(6)) as Record<string, unknown>;
      if (parsed.result !== undefined) return parsed.result;
      if (parsed.error) {
        const err = obj(parsed.error);
        throw new Error(str(err.message) ?? JSON.stringify(parsed.error));
      }
      return parsed;
    }
    throw new Error("No data in MCP SSE response");
  }

  const json = await res.json() as Record<string, unknown>;
  if (json.error) {
    const err = obj(json.error);
    throw new Error(str(err.message) ?? JSON.stringify(json.error));
  }
  return json.result;
}

async function callMetaTool(
  mcpUrl: string,
  apiKey: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = obj(await mcpCall(mcpUrl, apiKey, "tools/call", {
    name: toolName,
    arguments: args,
  }));
  const content = Array.isArray(result.content) ? result.content : [];
  const textBlock = content.find((entry) => obj(entry).type === "text");
  if (!textBlock) return {};
  return obj(JSON.parse(str(obj(textBlock).text) ?? "{}"));
}

const DISCOVERY_QUERIES = [
  { query: "email" },
  { query: "messaging chat" },
  { query: "calendar schedule" },
  { query: "files documents" },
  { query: "tasks projects" },
  { query: "code repository" },
];

class McpPersonalProvider implements PersonalProvider {
  private sessionMcpUrl: string | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly apiBase: string,
    private readonly userId: string,
    private readonly preferredMcpUrl: string | null,
    private readonly callbackUrl: string | null,
    private readonly authConfigMap: Record<string, string>,
  ) {}

  private withUserId(rawUrl: string): string {
    const url = new URL(rawUrl);
    if (!url.searchParams.get("user_id")) {
      url.searchParams.set("user_id", this.userId);
    }
    return url.toString();
  }

  private async ensureMcpUrl(): Promise<string> {
    if (this.sessionMcpUrl) return this.sessionMcpUrl;

    if (this.preferredMcpUrl) {
      this.sessionMcpUrl = this.withUserId(this.preferredMcpUrl);
      return this.sessionMcpUrl;
    }

    const body: Record<string, unknown> = { user_id: this.userId };
    if (Object.keys(this.authConfigMap).length > 0) {
      body["auth_configs"] = this.authConfigMap;
    }
    if (this.callbackUrl) {
      body["manage_connections"] = {
        enabled: true,
        callback_url: this.callbackUrl,
        enable_wait_for_connections: true,
      };
    }

    const session = await composioApiCall(this.apiBase, this.apiKey, "/tool_router/session", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const mcp = obj(session.mcp);
    const url = str(mcp.url);
    if (!url) throw new Error("Composio session missing mcp.url");

    this.sessionMcpUrl = this.withUserId(url);
    return this.sessionMcpUrl;
  }

  private async meta(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const mcpUrl = await this.ensureMcpUrl();
    return callMetaTool(mcpUrl, this.apiKey, tool, args);
  }

  private connectionFromStatus(toolkit: string, info: Record<string, unknown>): PersonalConnection {
    return {
      toolkit,
      status: (str(info.status) ?? "unknown").toUpperCase(),
      connectedAccountId: str(info.connected_account_id) ?? str(info.connectedAccountId),
      userInfo: info.current_user_info ? obj(info.current_user_info) : null,
      redirectUrl: str(info.redirect_url) ?? str(info.redirectUrl),
    };
  }

  async discoverConnections(): Promise<PersonalConnection[]> {
    const parsed = await this.meta("COMPOSIO_SEARCH_TOOLS", { queries: DISCOVERY_QUERIES });
    const data = obj(parsed.data);
    const statuses = Array.isArray(data.toolkit_connection_statuses)
      ? data.toolkit_connection_statuses
      : [];

    return statuses
      .filter((entry) => obj(entry).has_active_connection === true)
      .map((entry) => {
        const row = obj(entry);
        const details = obj(row.connection_details);
        return {
          toolkit: str(row.toolkit) ?? "unknown",
          status: "ACTIVE",
          connectedAccountId: str(details.connected_account_id),
          userInfo: row.current_user_info ? obj(row.current_user_info) : null,
          redirectUrl: null,
        };
      });
  }

  async checkConnections(toolkits: string[]): Promise<PersonalConnection[]> {
    const parsed = await this.meta("COMPOSIO_MANAGE_CONNECTIONS", { toolkits });
    const data = obj(parsed.data);
    const results = obj(data.results);
    return toolkits.map((toolkit) => {
      const row = obj(results[toolkit]);
      return Object.keys(row).length > 0
        ? this.connectionFromStatus(toolkit, row)
        : {
            toolkit,
            status: "NOT_CONNECTED",
            connectedAccountId: null,
            userInfo: null,
            redirectUrl: null,
          };
    });
  }

  async connectApp(toolkit: string): Promise<PersonalConnection> {
    const [connection] = await this.checkConnections([toolkit]);
    return connection ?? {
      toolkit,
      status: "UNKNOWN",
      connectedAccountId: null,
      userInfo: null,
      redirectUrl: null,
    };
  }

  async waitForConnection(toolkit: string): Promise<PersonalConnection> {
    const parsed = await this.meta("COMPOSIO_WAIT_FOR_CONNECTIONS", { toolkits: [toolkit] });
    const data = obj(parsed.data);
    const results = obj(data.results);
    return this.connectionFromStatus(toolkit, obj(results[toolkit]));
  }

  async disconnectAccount(_connectedAccountId: string): Promise<void> {
    throw new Error("Disconnect is not supported by the MCP personal provider");
  }

  async resolveAccountIdentity(
    toolkit: string,
    connectedAccountId: string,
  ): Promise<Record<string, unknown> | null> {
    const connections = await this.checkConnections([toolkit]);
    const found = connections.find((connection) => connection.connectedAccountId === connectedAccountId);
    return found?.userInfo ?? null;
  }

  async searchTools(
    query: string,
    options?: { toolkit?: string; limit?: number },
  ): Promise<PersonalToolInfo[]> {
    const queries = options?.toolkit
      ? [{ query, toolkits: [options.toolkit] }]
      : [{ query }];
    const parsed = await this.meta("COMPOSIO_SEARCH_TOOLS", { queries });
    const data = obj(parsed.data);
    const results = Array.isArray(data.results) ? data.results : [];
    const schemas = obj(data.tool_schemas);
    const tools: PersonalToolInfo[] = [];

    for (const result of results) {
      const row = obj(result);
      const primary = Array.isArray(row.primary_tool_slugs) ? row.primary_tool_slugs : [];
      const related = Array.isArray(row.related_tool_slugs) ? row.related_tool_slugs : [];
      const toolkitNames = Array.isArray(row.toolkits) ? row.toolkits : [];
      const toolkit = str(toolkitNames[0]);
      for (const slugValue of [...primary, ...related]) {
        const slug = str(slugValue);
        if (!slug) continue;
        const schema = obj(schemas[slug]);
        tools.push({
          slug,
          description: str(schema.description),
          toolkit: str(schema.toolkit)?.toLowerCase() ?? toolkit,
        });
      }
    }

    return tools.slice(0, options?.limit ?? 20);
  }

  async getToolSchema(slug: string): Promise<PersonalToolSchema | null> {
    const parsed = await this.meta("COMPOSIO_GET_TOOL_SCHEMAS", { tool_slugs: [slug] });
    const data = obj(parsed.data);
    const schemas = obj(data.schemas ?? data);
    const schema = obj(schemas[slug] ?? Object.values(schemas)[0]);
    const parameters = obj(schema.input_schema ?? schema.inputSchema);
    if (Object.keys(parameters).length === 0) return null;
    return {
      slug: str(schema.tool_slug) ?? slug,
      description: str(schema.description),
      parameters,
    };
  }

  async executeTool(
    slug: string,
    args: Record<string, unknown>,
    connectedAccountId?: string,
  ): Promise<PersonalExecResult> {
    try {
      const toolCall: Record<string, unknown> = {
        tool_slug: slug,
        arguments: args,
      };
      if (connectedAccountId) {
        toolCall.connected_account_id = connectedAccountId;
      }

      const parsed = await this.meta("COMPOSIO_MULTI_EXECUTE_TOOL", {
        tools: [toolCall],
      });
      const data = obj(parsed.data);
      const results = Array.isArray(data.results) ? data.results : [];
      const first = obj(results[0]);
      const response = obj(first.response);
      if (response.successful === false || parsed.successful === false) {
        return {
          tool: slug,
          success: false,
          data: null,
          error: str(response.error) ?? str(parsed.error) ?? "Execution failed",
        };
      }
      return {
        tool: slug,
        success: true,
        data: response.data ?? response,
        error: null,
      };
    } catch (error) {
      return {
        tool: slug,
        success: false,
        data: null,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }
}

// ── Factory ──

export const createPersonalProvider = (
  ctx: CoreContext,
  override?: PersonalProvider,
): PersonalProvider => {
  if (override) return override;

  const platformSettings = loadPlatformSettings(ctx.homeDir, ctx.env);
  const apiKey = ctx.env.COMPOSIO_API_KEY?.trim() || platformSettings.apiKey;
  if (!apiKey) return new NoopPersonalProvider();

  const userId =
    ctx.env.COMPOSIO_USER_ID?.trim() ||
    loadOrCreateUserId(ctx.homeDir, ctx.env);
  const authConfigMap = (() => {
    try {
      const fromEnv = JSON.parse(ctx.env.COMPOSIO_AUTH_CONFIG_MAP_JSON ?? "{}") as Record<string, string>;
      return {
        ...(platformSettings.authConfigMap ?? {}),
        ...fromEnv,
      };
    } catch {
      return { ...(platformSettings.authConfigMap ?? {}) };
    }
  })();
  for (const [key, value] of Object.entries(ctx.env)) {
    if (!key.startsWith("COMPOSIO_AUTH_CONFIG_") || !value?.trim()) continue;
    const toolkit = key.replace("COMPOSIO_AUTH_CONFIG_", "").toLowerCase();
    authConfigMap[toolkit] = value.trim();
  }

  return new McpPersonalProvider(
    apiKey,
    ctx.env.COMPOSIO_API_BASE || platformSettings.apiBase || DEFAULT_API_BASE,
    userId,
    ctx.env.COMPOSIO_MCP_URL || platformSettings.mcpUrl || null,
    ctx.env.COMPOSIO_CALLBACK_URL ?? platformSettings.callbackUrl ?? null,
    authConfigMap,
  );
};
