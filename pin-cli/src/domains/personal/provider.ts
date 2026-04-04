/**
 * Composio MCP provider for personal data access.
 *
 * Uses 5 of the 7 Composio meta tools via MCP JSON-RPC:
 *   1. COMPOSIO_MANAGE_CONNECTIONS — check/initiate app connections
 *   2. COMPOSIO_SEARCH_TOOLS       — discover tools + connection statuses
 *   3. COMPOSIO_GET_TOOL_SCHEMAS   — get tool input parameters
 *   4. COMPOSIO_MULTI_EXECUTE_TOOL — execute app tools (Gmail, Slack, etc.)
 *   5. COMPOSIO_WAIT_FOR_CONNECTIONS — poll until OAuth completes
 *
 * Not used (agent-only sandbox):
 *   6. COMPOSIO_REMOTE_WORKBENCH
 *   7. COMPOSIO_REMOTE_BASH_TOOL
 */

import type { CliRuntimeInput } from "../../runtime.js";
import { loadConsumerKey } from "./service.js";

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
  private fail(): never { throw new Error("COMPOSIO_CONSUMER_KEY is not configured"); }
  async discoverConnections(): Promise<PersonalConnection[]> { return []; }
  async checkConnections(): Promise<PersonalConnection[]> { this.fail(); }
  async connectApp(): Promise<PersonalConnection> { this.fail(); }
  async waitForConnection(): Promise<PersonalConnection> { this.fail(); }
  async searchTools(): Promise<PersonalToolInfo[]> { this.fail(); }
  async getToolSchema(): Promise<PersonalToolSchema | null> { this.fail(); }
  async executeTool(): Promise<PersonalExecResult> { this.fail(); }
}

// ── MCP Transport ──

const DEFAULT_MCP_URL = "https://connect.composio.dev/mcp";

async function mcpCall(
  mcpUrl: string,
  consumerKey: string,
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
      "x-consumer-api-key": consumerKey,
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
      if (line.startsWith("data: ")) {
        const parsed = JSON.parse(line.slice(6));
        if (parsed.result !== undefined) return parsed.result;
        if (parsed.error) throw new Error(parsed.error.message ?? JSON.stringify(parsed.error));
        return parsed;
      }
    }
    throw new Error("No data in SSE response");
  }

  const json = await res.json() as Record<string, unknown>;
  if (json.error) {
    const err = obj(json.error);
    throw new Error(str(err.message as unknown as string) ?? JSON.stringify(json.error));
  }
  return json.result;
}

/** Call a Composio meta tool and extract the text content as parsed JSON. */
async function callMetaTool(
  mcpUrl: string,
  consumerKey: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = obj(
    await mcpCall(mcpUrl, consumerKey, "tools/call", { name: toolName, arguments: args }),
  );
  const content = Array.isArray(result.content) ? result.content : [];
  const textBlock = content.find((c: unknown) => obj(c).type === "text");
  if (!textBlock) return {};
  return obj(JSON.parse(obj(textBlock).text as string));
}

// ── MCP Provider ──

/** Broad queries to discover what toolkits the user has connected. */
const DISCOVERY_QUERIES = [
  { query: "email" },
  { query: "messaging chat" },
  { query: "calendar schedule" },
  { query: "files documents" },
  { query: "tasks projects" },
  { query: "code repository" },
];

class McpPersonalProvider implements PersonalProvider {
  constructor(
    private readonly key: string,
    private readonly url: string = DEFAULT_MCP_URL,
  ) {}

  private meta(tool: string, args: Record<string, unknown>) {
    return callMetaTool(this.url, this.key, tool, args);
  }

  // ── COMPOSIO_SEARCH_TOOLS: discover connections ──

  async discoverConnections(): Promise<PersonalConnection[]> {
    const parsed = await this.meta("COMPOSIO_SEARCH_TOOLS", {
      queries: DISCOVERY_QUERIES,
    });
    const data = obj(parsed.data);
    const statuses = Array.isArray(data.toolkit_connection_statuses)
      ? data.toolkit_connection_statuses
      : [];

    return statuses
      .filter((s: unknown) => obj(s).has_active_connection === true)
      .map((s: unknown) => {
        const row = obj(s);
        const connDetails = obj(row.connection_details);
        const userInfo = row.current_user_info
          ? obj(row.current_user_info)
          : null;
        return {
          toolkit: str(row.toolkit as unknown as string) ?? "unknown",
          status: "ACTIVE",
          connectedAccountId: str(connDetails.connected_account_id as unknown as string),
          userInfo,
          redirectUrl: null,
        };
      });
  }

  // ── COMPOSIO_MANAGE_CONNECTIONS: check/initiate specific toolkits ──

  async checkConnections(toolkits: string[]): Promise<PersonalConnection[]> {
    const parsed = await this.meta("COMPOSIO_MANAGE_CONNECTIONS", { toolkits });
    const data = obj(parsed.data);
    const results = obj(data.results);

    return Object.entries(results).map(([toolkit, info]) => {
      const r = obj(info);
      return {
        toolkit,
        status: (str(r.status as unknown as string) ?? "unknown").toUpperCase(),
        connectedAccountId: str(r.connected_account_id as unknown as string),
        userInfo: r.current_user_info ? obj(r.current_user_info) : null,
        redirectUrl: str(r.redirect_url as unknown as string),
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

  // ── COMPOSIO_WAIT_FOR_CONNECTIONS ──

  async waitForConnection(toolkit: string): Promise<PersonalConnection> {
    const parsed = await this.meta("COMPOSIO_WAIT_FOR_CONNECTIONS", {
      toolkits: [toolkit],
    });
    const data = obj(parsed.data);
    const results = obj(data.results);
    const r = obj(results[toolkit]);
    return {
      toolkit,
      status: (str(r.status as unknown as string) ?? "unknown").toUpperCase(),
      connectedAccountId: str(r.connected_account_id as unknown as string),
      userInfo: null,
      redirectUrl: null,
    };
  }

  // ── COMPOSIO_SEARCH_TOOLS ──

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
      const r = obj(result);
      const primarySlugs = Array.isArray(r.primary_tool_slugs) ? r.primary_tool_slugs : [];
      const relatedSlugs = Array.isArray(r.related_tool_slugs) ? r.related_tool_slugs : [];
      const toolkitNames = Array.isArray(r.toolkits) ? r.toolkits : [];
      const toolkit = str(toolkitNames[0] as unknown as string);

      for (const slug of [...primarySlugs, ...relatedSlugs]) {
        const s = str(slug as unknown as string);
        if (!s) continue;
        const schema = obj(schemas[s]);
        tools.push({
          slug: s,
          description: str(schema.description as unknown as string),
          toolkit: str(schema.toolkit as unknown as string)?.toLowerCase() ?? toolkit,
        });
      }
    }

    return tools.slice(0, options?.limit ?? 20);
  }

  // ── COMPOSIO_GET_TOOL_SCHEMAS ──

  async getToolSchema(slug: string): Promise<PersonalToolSchema | null> {
    const parsed = await this.meta("COMPOSIO_GET_TOOL_SCHEMAS", {
      tool_slugs: [slug],
    });
    const data = obj(parsed.data);
    const schemas = obj(data.schemas ?? data);
    const schema = obj(schemas[slug] ?? Object.values(schemas)[0]);

    if (!schema.input_schema && !schema.inputSchema) return null;

    return {
      slug: str(schema.tool_slug as unknown as string) ?? slug,
      description: str(schema.description as unknown as string),
      parameters: obj(schema.input_schema ?? schema.inputSchema),
    };
  }

  // ── COMPOSIO_MULTI_EXECUTE_TOOL ──

  async executeTool(
    slug: string,
    args: Record<string, unknown>,
  ): Promise<PersonalExecResult> {
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
          error: str(response.error as unknown as string)
            ?? str(parsed.error as unknown as string)
            ?? "Execution failed",
        };
      }

      return { tool: slug, success: true, data: response.data ?? response, error: null };
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
  runtime: CliRuntimeInput,
  override?: PersonalProvider,
): PersonalProvider => {
  if (override) return override;

  const consumerKey = runtime.env.COMPOSIO_CONSUMER_KEY || loadConsumerKey(runtime.homeDir);
  if (!consumerKey) return new NoopPersonalProvider();

  const mcpUrl = runtime.env.COMPOSIO_MCP_URL || DEFAULT_MCP_URL;
  return new McpPersonalProvider(consumerKey, mcpUrl);
};
