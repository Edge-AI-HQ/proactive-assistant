/**
 * Composio provider for personal data access.
 *
 * Current default transport in this repo:
 *   - Platform API key (`ak_...`) + MCP meta tools.
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
  /** Discover connected apps via broad tool search (no hardcoded list). */
  discoverConnections(): Promise<PersonalConnection[]>;
  /** Check specific toolkits' connection status. */
  checkConnections(toolkits: string[]): Promise<PersonalConnection[]>;
  /** Initiate or check a single toolkit connection. Returns redirect URL if not connected. */
  connectApp(toolkit: string): Promise<PersonalConnection>;
  /** Wait for an OAuth connection to become active. */
  waitForConnection(toolkit: string): Promise<PersonalConnection>;
  /** Search tools by use case (returns tools + connection statuses). */
  searchTools(query: string, options?: { toolkit?: string; limit?: number }): Promise<PersonalToolInfo[]>;
  /** Get tool input schema. */
  getToolSchema(slug: string): Promise<PersonalToolSchema | null>;
  /** Execute a tool via COMPOSIO_MULTI_EXECUTE_TOOL. */
  executeTool(slug: string, args: Record<string, unknown>): Promise<PersonalExecResult>;
  /** Disconnect (delete) an active connection for a toolkit. */
  disconnectApp(toolkit: string): Promise<PersonalConnection>;
}

// ── Helpers ──

const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

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
  async disconnectApp(): Promise<PersonalConnection> { this.fail(); }
}

const DEFAULT_API_BASE = "https://backend.composio.dev/api/v3";
const DEFAULT_MCP_URL = "https://connect.composio.dev/mcp";

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const parseJson = async (response: Response): Promise<Record<string, unknown>> => {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }

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
  authHeader: "x-api-key" | "x-consumer-api-key",
  key: string,
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
      [authHeader]: key,
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
  authHeader: "x-api-key" | "x-consumer-api-key",
  key: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = obj(await mcpCall(mcpUrl, authHeader, key, "tools/call", {
    name: toolName,
    arguments: args,
  }));
  const content = Array.isArray(result.content) ? result.content : [];
  const textBlock = content.find((entry) => obj(entry).type === "text");
  if (!textBlock) return {};
  return obj(JSON.parse(str(obj(textBlock).text) ?? "{}"));
}

class McpPersonalProvider implements PersonalProvider {
  private sessionMcpUrl: string | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly apiBase: string,
    private readonly userId: string,
    private readonly preferredMcpUrl: string | null,
    private readonly authHeader: "x-api-key" | "x-consumer-api-key",
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

    const body: Record<string, unknown> = {
      user_id: this.userId,
    };
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
    if (!url) {
      throw new Error("Composio session missing mcp.url");
    }

    this.sessionMcpUrl = this.withUserId(url);
    return this.sessionMcpUrl;
  }

  private async meta(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const mcpUrl = await this.ensureMcpUrl();
    return callMetaTool(mcpUrl, this.authHeader, this.apiKey, tool, args);
  }

  /** Use Platform REST API for connection listing — much faster than MCP search. */
  private platformDelegate(): PlatformPersonalProvider {
    return new PlatformPersonalProvider({
      apiKey: this.apiKey,
      apiBase: this.apiBase,
      userId: this.userId,
      callbackUrl: this.callbackUrl,
      authConfigMap: this.authConfigMap,
    });
  }

  async discoverConnections(): Promise<PersonalConnection[]> {
    return this.platformDelegate().discoverConnections();
  }

  async checkConnections(toolkits: string[]): Promise<PersonalConnection[]> {
    const parsed = await this.meta("COMPOSIO_MANAGE_CONNECTIONS", { toolkits });
    const data = obj(parsed.data);
    const results = obj(data.results);
    return Object.entries(results).map(([toolkit, info]) => {
      const row = obj(info);
      return {
        toolkit,
        status: (str(row.status) ?? "unknown").toUpperCase(),
        connectedAccountId: str(row.connected_account_id),
        userInfo: row.current_user_info ? obj(row.current_user_info) : null,
        redirectUrl: str(row.redirect_url),
      };
    });
  }

  async connectApp(toolkit: string): Promise<PersonalConnection> {
    const connections = await this.checkConnections([toolkit]);
    return connections[0] ?? {
      toolkit,
      status: "UNKNOWN",
      connectedAccountId: null,
      userInfo: null,
      redirectUrl: null,
    };
  }

  async waitForConnection(toolkit: string): Promise<PersonalConnection> {
    return this.platformDelegate().waitForConnection(toolkit);
  }

  async disconnectApp(toolkit: string): Promise<PersonalConnection> {
    return this.platformDelegate().disconnectApp(toolkit);
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
    if (!schema.input_schema && !schema.inputSchema) return null;
    return {
      slug: str(schema.tool_slug) ?? slug,
      description: str(schema.description),
      parameters: obj(schema.input_schema ?? schema.inputSchema),
    };
  }

  async executeTool(slug: string, args: Record<string, unknown>): Promise<PersonalExecResult> {
    try {
      const parsed = await this.meta("COMPOSIO_MULTI_EXECUTE_TOOL", {
        tools: [{ tool_slug: slug, arguments: args }],
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

// ── Platform API Provider ──

interface PlatformProviderOptions {
  apiKey: string;
  apiBase: string;
  userId: string;
  callbackUrl?: string | null;
  authConfigMap: Record<string, string>;
}

class PlatformPersonalProvider implements PersonalProvider {
  private readonly authConfigCache = new Map<string, string>();

  constructor(private readonly options: PlatformProviderOptions) {
    for (const [toolkit, authConfigId] of Object.entries(options.authConfigMap)) {
      this.authConfigCache.set(toolkit, authConfigId);
    }
  }

  private async api(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
    return composioApiCall(this.options.apiBase, this.options.apiKey, path, init);
  }

  private toConnection(toolkit: string, row: Record<string, unknown> | null): PersonalConnection {
    const normalizedToolkit =
      str(obj(row?.toolkit).slug) ??
      str(row?.toolkit) ??
      toolkit;

    return {
      toolkit: normalizedToolkit,
      status: (str(row?.status) ?? "NOT_CONNECTED").toUpperCase(),
      connectedAccountId:
        str(row?.id) ??
        str(row?.connected_account_id) ??
        str(row?.connectedAccountId),
      userInfo:
        row?.user_info ? obj(row.user_info) :
        row?.current_user_info ? obj(row.current_user_info) :
        null,
      redirectUrl:
        str(row?.redirect_url) ??
        str(row?.redirectUrl),
    };
  }

  private async listConnectedAccounts(filters?: {
    toolkits?: string[];
    statuses?: string[];
    connectedAccountIds?: string[];
  }): Promise<Record<string, unknown>[]> {
    const params = new URLSearchParams();
    params.set("user_ids", this.options.userId);
    params.set("limit", "100");

    if (filters?.toolkits?.length) {
      params.set("toolkit_slugs", filters.toolkits.join(","));
    }
    if (filters?.statuses?.length) {
      params.set("statuses", filters.statuses.join(","));
    }
    if (filters?.connectedAccountIds?.length) {
      params.set("connected_account_ids", filters.connectedAccountIds.join(","));
    }

    const response = await this.api(`/connected_accounts?${params.toString()}`);
    return Array.isArray(response.items)
      ? response.items.map((item) => obj(item))
      : [];
  }

  private async findLatestConnection(toolkit: string): Promise<Record<string, unknown> | null> {
    const items = await this.listConnectedAccounts({ toolkits: [toolkit] });
    if (items.length === 0) {
      return null;
    }

    return items.sort((left, right) => {
      const leftTs = str(left.updated_at) ?? str(left.created_at) ?? "";
      const rightTs = str(right.updated_at) ?? str(right.created_at) ?? "";
      return rightTs.localeCompare(leftTs);
    })[0] ?? null;
  }

  private async ensureAuthConfigId(toolkit: string): Promise<string> {
    const cached = this.authConfigCache.get(toolkit);
    if (cached) {
      return cached;
    }

    const list = await this.api(
      `/auth_configs?toolkit_slug=${encodeURIComponent(toolkit)}&is_composio_managed=true&limit=20`,
    );
    const existing = Array.isArray(list.items)
      ? list.items.map((item) => obj(item)).find((item) => str(item.id))
      : null;
    const existingId = str(existing?.id);
    if (existingId) {
      this.authConfigCache.set(toolkit, existingId);
      return existingId;
    }

    const created = await this.api("/auth_configs", {
      method: "POST",
      body: JSON.stringify({
        toolkit: { slug: toolkit },
      }),
    });
    const authConfigId =
      str(obj(created.auth_config).id) ??
      str(created.id);

    if (!authConfigId) {
      throw new Error(`Composio auth config creation returned no id for toolkit ${toolkit}`);
    }

    this.authConfigCache.set(toolkit, authConfigId);
    return authConfigId;
  }

  private async getToolDetails(slug: string): Promise<Record<string, unknown>> {
    return this.api(`/tools/${encodeURIComponent(slug)}?toolkit_versions=latest`);
  }

  async discoverConnections(): Promise<PersonalConnection[]> {
    const active = await this.listConnectedAccounts({ statuses: ["ACTIVE"] });
    return active.map((row) => this.toConnection(str(obj(row.toolkit).slug) ?? "unknown", row));
  }

  async checkConnections(toolkits: string[]): Promise<PersonalConnection[]> {
    const items = await this.listConnectedAccounts({ toolkits });
    const latestByToolkit = new Map<string, Record<string, unknown>>();

    for (const item of items) {
      const toolkit = str(obj(item.toolkit).slug) ?? "";
      if (!toolkit) continue;
      const current = latestByToolkit.get(toolkit);
      const itemTs = str(item.updated_at) ?? str(item.created_at) ?? "";
      const currentTs = current ? (str(current.updated_at) ?? str(current.created_at) ?? "") : "";
      if (!current || itemTs > currentTs) {
        latestByToolkit.set(toolkit, item);
      }
    }

    return toolkits.map((toolkit) =>
      this.toConnection(toolkit, latestByToolkit.get(toolkit) ?? null),
    );
  }

  async connectApp(toolkit: string): Promise<PersonalConnection> {
    const existing = await this.findLatestConnection(toolkit);
    if (existing && (str(existing.status) ?? "").toUpperCase() === "ACTIVE") {
      return this.toConnection(toolkit, existing);
    }

    const authConfigId = await this.ensureAuthConfigId(toolkit);
    const linked = await this.api("/connected_accounts/link", {
      method: "POST",
      body: JSON.stringify({
        auth_config_id: authConfigId,
        user_id: this.options.userId,
        ...(this.options.callbackUrl ? { callback_url: this.options.callbackUrl } : {}),
      }),
    });

    return {
      toolkit,
      status: "PENDING",
      connectedAccountId:
        str(linked.connected_account_id) ??
        str(linked.connectedAccountId),
      userInfo: null,
      redirectUrl:
        str(linked.redirect_url) ??
        str(linked.redirectUrl),
    };
  }

  async waitForConnection(toolkit: string): Promise<PersonalConnection> {
    const timeoutMs = 120_000;
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const latest = await this.findLatestConnection(toolkit);
      const status = (str(latest?.status) ?? "").toUpperCase();
      if (latest && status === "ACTIVE") {
        return this.toConnection(toolkit, latest);
      }
      await sleep(2_000);
    }

    const latest = await this.findLatestConnection(toolkit);
    return this.toConnection(toolkit, latest);
  }

  async disconnectApp(toolkit: string): Promise<PersonalConnection> {
    const latest = await this.findLatestConnection(toolkit);
    const accountId = str(latest?.id) ?? str(latest?.connected_account_id);
    if (!latest || !accountId) {
      return this.toConnection(toolkit, null);
    }
    await this.api(`/connected_accounts/${encodeURIComponent(accountId)}`, {
      method: "DELETE",
    });
    return { ...this.toConnection(toolkit, latest), status: "NOT_CONNECTED", connectedAccountId: null };
  }

  async searchTools(
    query: string,
    options?: { toolkit?: string; limit?: number },
  ): Promise<PersonalToolInfo[]> {
    const params = new URLSearchParams();
    params.set("query", query);
    params.set("limit", String(options?.limit ?? 20));
    params.set("toolkit_versions", "latest");
    if (options?.toolkit) {
      params.set("toolkit_slug", options.toolkit);
    }

    const response = await this.api(`/tools?${params.toString()}`);
    const items = Array.isArray(response.items) ? response.items : [];

    return items.map((item) => {
      const row = obj(item);
      return {
        slug: str(row.slug) ?? "unknown",
        description: str(row.description),
        toolkit: str(obj(row.toolkit).slug),
      };
    });
  }

  async getToolSchema(slug: string): Promise<PersonalToolSchema | null> {
    const tool = await this.getToolDetails(slug);
    const parameters =
      obj(tool.input_parameters).constructor === Object && Object.keys(obj(tool.input_parameters)).length > 0
        ? obj(tool.input_parameters)
        : obj(tool.inputSchema);

    if (Object.keys(parameters).length === 0) {
      return null;
    }

    return {
      slug: str(tool.slug) ?? slug,
      description: str(tool.description),
      parameters,
    };
  }

  async executeTool(
    slug: string,
    args: Record<string, unknown>,
  ): Promise<PersonalExecResult> {
    try {
      const tool = await this.getToolDetails(slug);
      const toolkit = str(obj(tool.toolkit).slug);
      const latest = toolkit ? await this.findLatestConnection(toolkit) : null;
      const connectedAccountId =
        str(latest?.id) ??
        str(latest?.connected_account_id);

      const response = await this.api(`/tools/execute/${encodeURIComponent(slug)}`, {
        method: "POST",
        body: JSON.stringify({
          user_id: this.options.userId,
          ...(connectedAccountId ? { connected_account_id: connectedAccountId } : {}),
          arguments: args,
        }),
      });

      return {
        tool: slug,
        success: true,
        data: response,
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

  const platformSettings = loadPlatformSettings(ctx.homeDir);
  const apiKey = ctx.env.COMPOSIO_API_KEY?.trim() || platformSettings.apiKey;
  if (!apiKey) return new NoopPersonalProvider();

  const userId =
    ctx.env.COMPOSIO_USER_ID?.trim() ||
    loadOrCreateUserId(ctx.homeDir);
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
    "x-api-key",
    ctx.env.COMPOSIO_CALLBACK_URL ?? platformSettings.callbackUrl ?? null,
    authConfigMap,
  );
};
