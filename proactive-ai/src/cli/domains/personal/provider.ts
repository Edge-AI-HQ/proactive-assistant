/**
 * Composio Platform API provider for personal data access.
 *
 * Uses the Composio v3 REST API to:
 *   1. List/manage connected accounts (OAuth connections)
 *   2. Search and discover available tools
 *   3. Get tool input schemas
 *   4. Execute tools on behalf of the user
 */

import type { CliRuntimeInput } from "../../runtime.js";
import { loadPlatformSettings } from "./platform_settings.js";
import { loadOrCreateUserId } from "../../../core/domains/personal/platform_settings.js";

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
  private fail(): never { throw new Error("COMPOSIO_API_KEY is not configured"); }
  async discoverConnections(): Promise<PersonalConnection[]> { return []; }
  async checkConnections(): Promise<PersonalConnection[]> { this.fail(); }
  async connectApp(): Promise<PersonalConnection> { this.fail(); }
  async waitForConnection(): Promise<PersonalConnection> { this.fail(); }
  async searchTools(): Promise<PersonalToolInfo[]> { this.fail(); }
  async getToolSchema(): Promise<PersonalToolSchema | null> { this.fail(); }
  async executeTool(): Promise<PersonalExecResult> { this.fail(); }
}

const DEFAULT_API_BASE = "https://backend.composio.dev/api/v3";

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
  runtime: CliRuntimeInput,
  override?: PersonalProvider,
): PersonalProvider => {
  if (override) return override;

  const platformSettings = loadPlatformSettings(runtime.homeDir, runtime.env);
  const apiKey = runtime.env.COMPOSIO_API_KEY?.trim() || platformSettings.apiKey;
  if (!apiKey) return new NoopPersonalProvider();

  const authConfigMap = (() => {
    try {
      const fromEnv = JSON.parse(runtime.env.COMPOSIO_AUTH_CONFIG_MAP_JSON ?? "{}") as Record<string, string>;
      return {
        ...(platformSettings.authConfigMap ?? {}),
        ...fromEnv,
      };
    } catch {
      return { ...(platformSettings.authConfigMap ?? {}) };
    }
  })();

  for (const [key, value] of Object.entries(runtime.env)) {
    if (!key.startsWith("COMPOSIO_AUTH_CONFIG_") || !value?.trim()) {
      continue;
    }
    const toolkit = key
      .replace("COMPOSIO_AUTH_CONFIG_", "")
      .toLowerCase();
    authConfigMap[toolkit] = value.trim();
  }

  const userId =
    runtime.env.COMPOSIO_USER_ID?.trim() ||
    loadOrCreateUserId(runtime.homeDir, runtime.env);

  return new PlatformPersonalProvider({
    apiKey,
    apiBase: runtime.env.COMPOSIO_API_BASE || platformSettings.apiBase || DEFAULT_API_BASE,
    userId,
    callbackUrl: runtime.env.COMPOSIO_CALLBACK_URL ?? platformSettings.callbackUrl ?? null,
    authConfigMap,
  });
};
