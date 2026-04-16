/**
 * Composio provider for personal data access.
 *
 * Uses Platform REST API (v3) exclusively.
 */

import type { CoreContext } from "../../context.js";
import {
  loadPlatformSettings,
  loadOrCreateUserId,
  saveAccountIdentity,
  deleteAccountIdentity,
  pruneOrphanIdentities,
  type AccountIdentity,
} from "./platform_settings.js";

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
  searchTools(
    query: string,
    options?: { toolkit?: string; limit?: number },
  ): Promise<PersonalToolInfo[]>;
  /** Get tool input schema. */
  getToolSchema(slug: string): Promise<PersonalToolSchema | null>;
  /** Execute a tool. If connectedAccountId is omitted, uses the most recent active account. */
  executeTool(
    slug: string,
    args: Record<string, unknown>,
    connectedAccountId?: string,
  ): Promise<PersonalExecResult>;
  /** Disconnect (delete) a specific connected account by ID. */
  disconnectAccount(connectedAccountId: string): Promise<void>;
  /** Resolve human-readable identity for a connected account (best-effort). */
  resolveAccountIdentity(
    toolkit: string,
    connectedAccountId: string,
  ): Promise<Record<string, unknown> | null>;
}

// ── Helpers ──

const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** OAuth/OIDC claim keys and other machine fields — never use as human-facing label. */
const OAUTH_OR_MACHINE_KEY =
  /^(iss|issuer|aud|azp|jti|nonce|iat|exp|nbf|at_hash|c_hash|acr|amr|sid|kid|typ|alg|scope|session|flow_state|provider_id|ref)$/i;

const LEGACY_SKIP_KEYS =
  /token|secret|key|password|code|cursor|etag|sync|url|endpoint|slug|status|type|version|id$/i;

function isIdentityNoiseValue(value: string): boolean {
  const t = value.trim();
  if (!t) return true;
  const lower = t.toLowerCase();
  if (lower.startsWith("http://") || lower.startsWith("https://")) return true;
  if (/\bsupabase\.co\b/.test(lower)) return true;
  if (/\/auth\/v1\b/.test(t)) return true;
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(t)) return true;
  return false;
}

function identityKeySkippable(k: string): boolean {
  return OAUTH_OR_MACHINE_KEY.test(k) || LEGACY_SKIP_KEYS.test(k);
}

/** Case-insensitive field lookup with underscore/spacing normalization. */
function getStringFieldCI(
  info: Record<string, unknown>,
  ...candidates: string[]
): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/[_\s-]/g, "");
  const map = new Map<string, string>();
  for (const key of Object.keys(info)) map.set(norm(key), key);
  for (const want of candidates) {
    const orig = map.get(norm(want));
    if (!orig) continue;
    const v = info[orig];
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (!t || isIdentityNoiseValue(t)) continue;
    if (t.length > 120) continue;
    return t;
  }
  return null;
}

/**
 * Extract a human-readable identity string from Composio's `current_user_info`.
 * Prefers stable profile fields (email, display name) and ignores OIDC issuer/audience
 * and Supabase host strings that some payloads surface on native clients.
 */
export function extractIdentity(
  info: Record<string, unknown> | null | undefined,
): string | null {
  if (!info) return null;

  const preferred = getStringFieldCI(
    info,
    "email",
    "mail",
    "primaryEmailAddress",
    "primary_email",
    "userPrincipalName",
    "user_principal_name",
    "displayName",
    "display_name",
    "name",
    "full_name",
    "given_name",
    "username",
    "login",
    "preferred_username",
    "nickname",
  );
  if (preferred) {
    if (EMAIL_RE.test(preferred)) return preferred;
    if (!isIdentityNoiseValue(preferred)) return preferred;
  }

  for (const v of Object.values(info)) {
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (!EMAIL_RE.test(t) || isIdentityNoiseValue(t)) continue;
    return t;
  }

  for (const [k, v] of Object.entries(info)) {
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (!t || t.length > 60) continue;
    if (isIdentityNoiseValue(t)) continue;
    if (identityKeySkippable(k)) continue;
    return t;
  }

  return null;
}

// ── Noop (no key configured) ──

class NoopPersonalProvider implements PersonalProvider {
  private fail(): never {
    throw new Error("COMPOSIO_API_KEY is not configured");
  }
  async discoverConnections(): Promise<PersonalConnection[]> {
    return [];
  }
  async checkConnections(): Promise<PersonalConnection[]> {
    this.fail();
  }
  async connectApp(): Promise<PersonalConnection> {
    this.fail();
  }
  async waitForConnection(): Promise<PersonalConnection> {
    this.fail();
  }
  async searchTools(): Promise<PersonalToolInfo[]> {
    this.fail();
  }
  async getToolSchema(): Promise<PersonalToolSchema | null> {
    this.fail();
  }
  async executeTool(): Promise<PersonalExecResult> {
    this.fail();
  }
  async disconnectAccount(): Promise<void> {
    this.fail();
  }
  async resolveAccountIdentity(): Promise<Record<string, unknown> | null> {
    this.fail();
  }
}

const DEFAULT_API_BASE = "https://backend.composio.dev/api/v3";

/**
 * Maps toolkit slug → Composio tool that returns the authenticated user's identity.
 * All tools listed here require zero arguments.
 * Google workspace toolkits (googledocs, googlesheets) share the same Google OAuth
 * and fall back to GMAIL_GET_PROFILE via the GOOGLE_FAMILY_ALIAS below.
 */
const IDENTITY_TOOLS: Record<string, string> = {
  gmail: "GMAIL_GET_PROFILE",
  googlecalendar: "GOOGLECALENDAR_GET_CALENDAR_PROFILE",
  googledrive: "GOOGLEDRIVE_GET_ABOUT",
  slack: "SLACK_RETRIEVE_USER_PROFILE_INFORMATION",
  github: "GITHUB_LIST_EMAIL_ADDRESSES_FOR_THE_AUTHENTICATED_USER",
  linkedin: "LINKEDIN_GET_MY_INFO",
  notion: "NOTION_GET_ABOUT_ME",
  twitter: "TWITTER_USER_LOOKUP_ME",
  stripe: "STRIPE_GET_ACCOUNT",
  hubspot: "HUBSPOT_GET_ACCOUNT_INFO",
  asana: "ASANA_GET_CURRENT_USER",
  jira: "JIRA_GET_CURRENT_USER",
  trello: "TRELLO_GET_MEMBERS_ME",
  discord: "DISCORD_GET_MY_USER",
  spotify: "SPOTIFY_GET_CURRENT_USER_S_PROFILE",
  dropbox: "DROPBOX_GET_ABOUT_ME",
  todoist: "TODOIST_GET_USER",
  figma: "FIGMA_GET_CURRENT_USER",
  outlook: "OUTLOOK_GET_ME_CALENDAR",
  calendly: "CALENDLY_GET_CURRENT_USER",
  clickup: "CLICKUP_GET_AUTHORIZED_USER",
  strava: "STRAVA_GET_AUTHENTICATED_ATHLETE",
  zoom: "ZOOM_GET_USER",
};

const IDENTITY_TOOL_ARGS: Record<string, Record<string, unknown>> = {
  zoom: { userId: "me" },
};

const GOOGLE_FAMILY_ALIAS: Record<string, string> = {
  googledocs: "gmail",
  googlesheets: "gmail",
};

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const parseJson = async (
  response: Response,
): Promise<Record<string, unknown>> => {
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
    const message =
      str(json.message) ??
      str(json.error) ??
      JSON.stringify(json).slice(0, 300);
    throw new Error(`Composio API ${response.status}: ${message}`);
  }

  return json;
}

// ── Platform API Provider ──

interface PlatformProviderOptions {
  apiKey: string;
  apiBase: string;
  userId: string;
  homeDir: string;
  env: Record<string, string | undefined>;
  callbackUrl?: string | null;
  authConfigMap: Record<string, string>;
}

class PlatformPersonalProvider implements PersonalProvider {
  private readonly authConfigCache = new Map<string, string>();

  constructor(private readonly options: PlatformProviderOptions) {
    for (const [toolkit, authConfigId] of Object.entries(
      options.authConfigMap,
    )) {
      this.authConfigCache.set(toolkit, authConfigId);
    }
  }

  private async api(
    path: string,
    init?: RequestInit,
  ): Promise<Record<string, unknown>> {
    return composioApiCall(
      this.options.apiBase,
      this.options.apiKey,
      path,
      init,
    );
  }

  private toConnection(
    toolkit: string,
    row: Record<string, unknown> | null,
  ): PersonalConnection {
    const normalizedToolkit =
      str(obj(row?.toolkit).slug) ?? str(row?.toolkit) ?? toolkit;

    return {
      toolkit: normalizedToolkit,
      status: (str(row?.status) ?? "NOT_CONNECTED").toUpperCase(),
      connectedAccountId:
        str(row?.id) ??
        str(row?.connected_account_id) ??
        str(row?.connectedAccountId),
      userInfo: row?.user_info
        ? obj(row.user_info)
        : row?.current_user_info
          ? obj(row.current_user_info)
          : null,
      redirectUrl: str(row?.redirect_url) ?? str(row?.redirectUrl),
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
      params.set(
        "connected_account_ids",
        filters.connectedAccountIds.join(","),
      );
    }

    const response = await this.api(`/connected_accounts?${params.toString()}`);
    return Array.isArray(response.items)
      ? response.items.map((item) => obj(item))
      : [];
  }

  private async findLatestConnection(
    toolkit: string,
  ): Promise<Record<string, unknown> | null> {
    const items = await this.listConnectedAccounts({ toolkits: [toolkit] });
    if (items.length === 0) {
      return null;
    }

    return (
      items.sort((left, right) => {
        const leftTs = str(left.updated_at) ?? str(left.created_at) ?? "";
        const rightTs = str(right.updated_at) ?? str(right.created_at) ?? "";
        return rightTs.localeCompare(leftTs);
      })[0] ?? null
    );
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
    const authConfigId = str(obj(created.auth_config).id) ?? str(created.id);

    if (!authConfigId) {
      throw new Error(
        `Composio auth config creation returned no id for toolkit ${toolkit}`,
      );
    }

    this.authConfigCache.set(toolkit, authConfigId);
    return authConfigId;
  }

  private async getToolDetails(slug: string): Promise<Record<string, unknown>> {
    return this.api(
      `/tools/${encodeURIComponent(slug)}?toolkit_versions=latest`,
    );
  }

  async resolveAccountIdentity(
    toolkit: string,
    connectedAccountId: string,
  ): Promise<Record<string, unknown> | null> {
    return this.fetchAccountIdentityViaTool(toolkit, connectedAccountId);
  }

  /**
   * Execute the toolkit-specific identity tool to retrieve the authenticated
   * user's profile (email, name, etc.). Returns a flat key-value object that
   * can be fed to `extractIdentity()`, or null if no suitable tool exists.
   */
  private async fetchAccountIdentityViaTool(
    toolkit: string,
    connectedAccountId: string,
  ): Promise<Record<string, unknown> | null> {
    const effectiveToolkit = GOOGLE_FAMILY_ALIAS[toolkit] ?? toolkit;
    const toolSlug = IDENTITY_TOOLS[effectiveToolkit];
    if (!toolSlug) return null;

    try {
      const toolArgs = IDENTITY_TOOL_ARGS[effectiveToolkit] ?? {};
      const result = await this.api(
        `/tools/execute/${encodeURIComponent(toolSlug)}`,
        {
          method: "POST",
          body: JSON.stringify({
            connected_account_id: connectedAccountId,
            user_id: this.options.userId,
            arguments: toolArgs,
          }),
        },
      );

      if (!result.successful) return null;

      const data = obj(result.data);
      const responseData = obj(data.response_data);
      const source = Object.keys(responseData).length > 0 ? responseData : data;

      const flat: Record<string, unknown> = {};

      const putStringFlat = (key: string, val: string) => {
        if (!val || val.length >= 120) return;
        if (isIdentityNoiseValue(val)) return;
        if (identityKeySkippable(key)) return;
        flat[key] = val;
      };

      const extractFlat = (items: Record<string, unknown>[]) => {
        for (const item of items) {
          for (const [k, v] of Object.entries(item)) {
            if (typeof v === "string" && v.length > 0 && v.length < 120)
              putStringFlat(k, v);
          }
        }
      };

      if (Array.isArray(result.data)) {
        extractFlat((result.data as Record<string, unknown>[]).map(obj));
      } else {
        for (const [k, v] of Object.entries(source)) {
          if (Array.isArray(v)) {
            extractFlat(v.filter((i) => i && typeof i === "object").map(obj));
          } else if (v && typeof v === "object" && !Array.isArray(v)) {
            for (const [nk, nv] of Object.entries(
              v as Record<string, unknown>,
            )) {
              if (typeof nv === "string" && nv.length > 0 && nv.length < 120)
                putStringFlat(nk, nv);
            }
          } else if (typeof v === "string" && v.length > 0 && v.length < 120) {
            putStringFlat(k, v);
          } else if (typeof v === "number" || typeof v === "boolean") {
            flat[k] = v;
          }
        }
      }

      return Object.keys(flat).length > 0 ? flat : null;
    } catch {
      return null;
    }
  }

  async discoverConnections(): Promise<PersonalConnection[]> {
    const active = await this.listConnectedAccounts({ statuses: ["ACTIVE"] });
    const connections = active.map((row) =>
      this.toConnection(str(obj(row.toolkit).slug) ?? "unknown", row),
    );

    const { homeDir, env } = this.options;
    const cached = loadPlatformSettings(homeDir, env).accountIdentities ?? {};

    const enriched = await Promise.all(
      connections.map(async (conn) => {
        if (conn.userInfo && Object.keys(conn.userInfo).length > 0) return conn;
        if (!conn.connectedAccountId) return conn;

        const hit = cached[conn.connectedAccountId];
        if (hit?.userInfo && Object.keys(hit.userInfo).length > 0) {
          return { ...conn, userInfo: hit.userInfo };
        }

        try {
          const info = await this.fetchAccountIdentityViaTool(
            conn.toolkit,
            conn.connectedAccountId,
          );
          if (info) {
            saveAccountIdentity(
              homeDir,
              conn.connectedAccountId,
              { toolkit: conn.toolkit, userInfo: info },
              env,
            );
            return { ...conn, userInfo: info };
          }
          return conn;
        } catch {
          return conn;
        }
      }),
    );

    const activeIds = new Set(
      connections.map((c) => c.connectedAccountId).filter(Boolean) as string[],
    );
    pruneOrphanIdentities(homeDir, activeIds, env);

    return enriched;
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
        ...(this.options.callbackUrl
          ? { callback_url: this.options.callbackUrl }
          : {}),
      }),
    });

    return {
      toolkit,
      status: "PENDING",
      connectedAccountId:
        str(linked.connected_account_id) ?? str(linked.connectedAccountId),
      userInfo: null,
      redirectUrl: str(linked.redirect_url) ?? str(linked.redirectUrl),
    };
  }

  async waitForConnection(toolkit: string): Promise<PersonalConnection> {
    const timeoutMs = 120_000;
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const latest = await this.findLatestConnection(toolkit);
      const status = (str(latest?.status) ?? "").toUpperCase();
      if (latest && status === "ACTIVE") {
        const conn = this.toConnection(toolkit, latest);
        if (conn.connectedAccountId) {
          const info = await this.fetchAccountIdentityViaTool(
            toolkit,
            conn.connectedAccountId,
          ).catch(() => null);
          if (info) {
            const { homeDir, env } = this.options;
            saveAccountIdentity(
              homeDir,
              conn.connectedAccountId,
              { toolkit, userInfo: info },
              env,
            );
            return { ...conn, userInfo: info };
          }
        }
        return conn;
      }
      await sleep(2_000);
    }

    const latest = await this.findLatestConnection(toolkit);
    return this.toConnection(toolkit, latest);
  }

  async disconnectAccount(connectedAccountId: string): Promise<void> {
    await this.api(
      `/connected_accounts/${encodeURIComponent(connectedAccountId)}`,
      {
        method: "DELETE",
      },
    );
    deleteAccountIdentity(
      this.options.homeDir,
      connectedAccountId,
      this.options.env,
    );
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
      obj(tool.input_parameters).constructor === Object &&
      Object.keys(obj(tool.input_parameters)).length > 0
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
        const latest = toolkit
          ? await this.findLatestConnection(toolkit)
          : null;
        accountId =
          str(latest?.id) ?? str(latest?.connected_account_id) ?? undefined;
      }

      const response = await this.api(
        `/tools/execute/${encodeURIComponent(slug)}`,
        {
          method: "POST",
          body: JSON.stringify({
            user_id: this.options.userId,
            ...(accountId ? { connected_account_id: accountId } : {}),
            arguments: args,
          }),
        },
      );

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
      const fromEnv = JSON.parse(
        ctx.env.COMPOSIO_AUTH_CONFIG_MAP_JSON ?? "{}",
      ) as Record<string, string>;
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
    apiBase:
      ctx.env.COMPOSIO_API_BASE || platformSettings.apiBase || DEFAULT_API_BASE,
    userId,
    homeDir: ctx.homeDir,
    env: ctx.env,
    callbackUrl:
      ctx.env.COMPOSIO_CALLBACK_URL ?? platformSettings.callbackUrl ?? null,
    authConfigMap,
  });
};
