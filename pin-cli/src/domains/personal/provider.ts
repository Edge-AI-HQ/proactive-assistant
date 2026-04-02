import type { CliRuntimeInput } from "../../runtime.js";
import type { UpsertPersonalConnectedSourceInput } from "./repository.js";

export type PersonalDiscoveredSource = UpsertPersonalConnectedSourceInput;

interface RawConnectedAccountsClient {
  connectedAccounts: {
    list(query?: Record<string, unknown>): Promise<{ items?: unknown[] }>;
  };
}

export interface PersonalSourceProvider {
  listConnectedSources(): Promise<PersonalDiscoveredSource[]>;
}

class NoopPersonalSourceProvider implements PersonalSourceProvider {
  async listConnectedSources(): Promise<PersonalDiscoveredSource[]> {
    return [];
  }
}

const asJsonString = (value: unknown): string | null => {
  if (value === undefined || value === null) {
    return null;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
};

const toStringOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

class ComposioPersonalSourceProvider implements PersonalSourceProvider {
  constructor(
    private readonly runtime: CliRuntimeInput,
    private readonly apiKey: string,
  ) {}

  async listConnectedSources(): Promise<PersonalDiscoveredSource[]> {
    const { Composio } = await import("@composio/core");
    const composio = new Composio({ apiKey: this.apiKey });
    const rawClient = composio as unknown as { client: RawConnectedAccountsClient };
    const userId = this.runtime.env.PIN_COMPOSIO_USER_ID;
    const response = userId
      ? await rawClient.client.connectedAccounts.list({ user_ids: [userId] })
      : await rawClient.client.connectedAccounts.list();
    const items = Array.isArray((response as { items?: unknown[] }).items)
      ? ((response as { items?: unknown[] }).items ?? [])
      : [];

    return items.map((account) => {
      const row = account as Record<string, unknown>;
      const toolkit = (row.toolkit as Record<string, unknown> | undefined) ?? {};
      const status = toStringOrNull(row.status) ?? "UNKNOWN";
      const accountName =
        toStringOrNull(row.label) ??
        toStringOrNull(row.name) ??
        toStringOrNull(row.accountName) ??
        toStringOrNull(row.account_name);
      const connectedAccountId =
        toStringOrNull(row.id) ??
        toStringOrNull(row.nanoid) ??
        toStringOrNull(row.connectedAccountId) ??
        "unknown_connected_account";

      return {
        id: `src_${String((toolkit.slug ?? row.toolkitSlug ?? "unknown")).toLowerCase()}_${connectedAccountId}`,
        userId: toStringOrNull(row.userId) ?? toStringOrNull(row.user_id) ?? "unknown_user",
        provider: "composio",
        toolkit:
          toStringOrNull(toolkit.slug) ??
          toStringOrNull(row.toolkitSlug) ??
          toStringOrNull(row.toolkit_slug) ??
          "unknown",
        connectedAccountId,
        accountLabel: accountName,
        status,
        syncEnabled: status.toUpperCase() === "ACTIVE",
        scopesJson: asJsonString(row.scopes),
        authMetadataJson: asJsonString({
          userId: row.userId ?? row.user_id ?? null,
          authConfigId: row.authConfigId ?? row.auth_config_id ?? null,
        }),
        lastSeenAt: new Date().toISOString(),
      };
    });
  }
}

export const createPersonalSourceProvider = (
  runtime: CliRuntimeInput,
  override?: PersonalSourceProvider,
): PersonalSourceProvider => {
  if (override) {
    return override;
  }

  const apiKey = runtime.env.COMPOSIO_API_KEY;
  if (!apiKey) {
    return new NoopPersonalSourceProvider();
  }

  return new ComposioPersonalSourceProvider(runtime, apiKey);
};
