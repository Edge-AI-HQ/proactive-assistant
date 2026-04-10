/**
 * Composio provider for personal data access.
 *
 * Uses Platform REST API (v3) exclusively.
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
  /** Initiate a new OAuth connection for a toolkit (always creates a new link). */
  connectApp(toolkit: string): Promise<PersonalConnection>;
  /** Wait for an OAuth connection to become active. */
  waitForConnection(toolkit: string): Promise<PersonalConnection>;
  /** Search tools by use case (returns tools + connection statuses). */
  searchTools(query: string, options?: { toolkit?: string; limit?: number }): Promise<PersonalToolInfo[]>;
  /** Get tool input schema. */
  getToolSchema(slug: string): Promise<PersonalToolSchema | null>;
  /** Execute a tool. If connectedAccountId is omitted, uses the most recent active account. */
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

  // Pass 1: find an email in top-level values
  for (const v of Object.values(info)) {
    if (typeof v === "string" && EMAIL_RE.test(v)) return v;
  }

  // Pass 2: find a short, human-readable string (skip tokens/urls/ids)
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

  async resolveAccountIdentity(
    _toolkit: string,
    _connectedAccountId: string,
  ): Promise<Record<string, unknown> | null> {
    // Composio v3 API does not provide a reliable, scalable way to fetch
    // per-account user identity. Returning null; UI falls back to account ID.
    return null;
  }

  async discoverConnections(): Promise<PersonalConnection[]> {
    const active = await this.listConnectedAccounts({ statuses: ["ACTIVE"] });
    return active.map((row) => this.toConnection(str(obj(row.toolkit).slug) ?? "unknown", row));
  }

  async checkConnections(toolkits: string[]): Promise<PersonalConnection[]> {
    const items = await this.listConnectedAccounts({ toolkits });
    if (items.length === 0) {
      return toolkits.map((toolkit) => this.toConnection(toolkit, null));
    }
    return items.map((item) =>
      this.toConnection(str(obj(item.toolkit).slug) ?? "unknown", item),
    );
  }

  async connectApp(toolkit: string): Promise<PersonalConnection> {
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

  async disconnectAccount(connectedAccountId: string): Promise<void> {
    await this.api(`/connected_accounts/${encodeURIComponent(connectedAccountId)}`, {
      method: "DELETE",
    });
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
    connectedAccountId?: string,
  ): Promise<PersonalExecResult> {
    try {
      let accountId = connectedAccountId;
      if (!accountId) {
        const tool = await this.getToolDetails(slug);
        const toolkit = str(obj(tool.toolkit).slug);
        const latest = toolkit ? await this.findLatestConnection(toolkit) : null;
        accountId =
          str(latest?.id) ??
          str(latest?.connected_account_id) ??
          undefined;
      }

      const response = await this.api(`/tools/execute/${encodeURIComponent(slug)}`, {
        method: "POST",
        body: JSON.stringify({
          user_id: this.options.userId,
          ...(accountId ? { connected_account_id: accountId } : {}),
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

  return new PlatformPersonalProvider({
    apiKey,
    apiBase: ctx.env.COMPOSIO_API_BASE || platformSettings.apiBase || DEFAULT_API_BASE,
    userId,
    callbackUrl: ctx.env.COMPOSIO_CALLBACK_URL ?? platformSettings.callbackUrl ?? null,
    authConfigMap,
  });
};
