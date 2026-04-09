import { createHash } from "node:crypto";

import { world as coreWorld, personal as corePersonal } from "../../../core/index.js";

import { PinDatabaseManager } from "../../db/database.js";
import { resolveAppRootFromCtx } from "../../../core/paths.js";
import { okEnvelope } from "../../output/envelope.js";
import type { CliRuntimeInput, RunCliResult } from "../../runtime.js";
import { LoopRepository, type PendingItemInput } from "../loop/repository.js";

interface WorldItemFull {
  id?: string;
  title?: string;
  summary?: string | null;
  provider?: string;
  publishedAt?: string | null;
  updatedAt?: string;
}

interface PersonalConnection {
  toolkit?: string;
  status?: string;
  connectedAccountId?: string | null;
}

interface PersonalStatus {
  configured?: boolean;
}

interface IngestDeps {
  loadStore: () => Promise<{
    worldCursorUpdatedAt: string | null;
    personalSnapshotHash: string | null;
  }>;
  fetchWorldHeadlines: (input: { provider: string; limit: string }) => Promise<unknown>;
  fetchWorldItems: (input: { afterUpdatedAt?: string; limit: string; full: boolean }) => Promise<WorldItemFull[]>;
  fetchPersonalStatus: () => Promise<PersonalStatus>;
  fetchPersonalConnections: () => Promise<PersonalConnection[]>;
  enqueuePending: (input: {
    worldCursorUpdatedAt?: string | null;
    personalSnapshotHash?: string | null;
    items: PendingItemInput[];
  }) => Promise<{
    insertedCount: number;
    insertedBySource: Record<"world" | "personal", number>;
    pendingCount: number;
  }>;
}

const DEFAULT_WORLD_PROVIDERS = ["google-news", "sec", "fed"];
const DEFAULT_WORLD_LIMIT = 25;

function toIsoNow(): string {
  return new Date().toISOString();
}

function parseDomains(raw?: string): Array<"world" | "personal"> {
  const input = (raw ?? "world,personal")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const domains = new Set<"world" | "personal">();
  for (const value of input) {
    if (value === "world" || value === "personal") domains.add(value);
  }
  return domains.size > 0 ? [...domains] : ["world", "personal"];
}

function toConnectionFingerprint(connections: PersonalConnection[]): string {
  const normalized = connections
    .map((item) => ({
      toolkit: (item.toolkit ?? "").toLowerCase(),
      status: (item.status ?? "").toUpperCase(),
      connectedAccountId: item.connectedAccountId ?? null,
    }))
    .sort((a, b) => {
      const left = `${a.toolkit}:${a.status}:${a.connectedAccountId ?? ""}`;
      const right = `${b.toolkit}:${b.status}:${b.connectedAccountId ?? ""}`;
      return left.localeCompare(right);
    });
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function toWorldPendingItem(item: WorldItemFull, nowIso: string): PendingItemInput | null {
  const id = String(item.id ?? "").trim();
  if (!id) return null;
  return {
    id: `world:${id}`,
    source: "world",
    kind: "headline",
    createdAt: nowIso,
    availableAt: nowIso,
    status: "pending",
    processedAt: null,
    payload: {
      id,
      title: item.title ?? "",
      summary: item.summary ?? null,
      provider: item.provider ?? null,
      publishedAt: item.publishedAt ?? null,
      updatedAt: item.updatedAt ?? null,
    },
  };
}

function toPersonalPendingItem(
  connections: PersonalConnection[],
  fingerprint: string,
  nowIso: string,
): PendingItemInput {
  return {
    id: `personal:connections:${fingerprint}`,
    source: "personal",
    kind: "connections",
    createdAt: nowIso,
    availableAt: nowIso,
    status: "pending",
    processedAt: null,
    payload: {
      count: connections.length,
      snapshotHash: fingerprint,
      connections: connections.slice(0, 20).map((item) => ({
        toolkit: item.toolkit ?? "",
        status: item.status ?? "",
        connectedAccountId: item.connectedAccountId ?? null,
      })),
    },
  };
}

const createDeps = async (runtime: CliRuntimeInput): Promise<IngestDeps> => {
  const dataRoot = resolveAppRootFromCtx(runtime);
  const manager = new PinDatabaseManager(dataRoot);
  await manager.init();
  const repository = new LoopRepository(manager.open("pin"));
  return {
    loadStore: () => repository.loadIngestState(),
    fetchWorldHeadlines: (input) => coreWorld.fetchHeadlines(runtime, input),
    fetchWorldItems: (input) => coreWorld.listWorldItems(runtime, input),
    fetchPersonalStatus: () => corePersonal.status(runtime),
    fetchPersonalConnections: async () =>
      (await corePersonal.listConnections(runtime)) as PersonalConnection[],
    enqueuePending: (input) => repository.enqueuePending(input),
  };
};

const resolveDeps = async (
  runtime: CliRuntimeInput,
  overrides?: Partial<IngestDeps>,
): Promise<IngestDeps> => {
  if (
    overrides?.loadStore
    && overrides.fetchWorldHeadlines
    && overrides.fetchWorldItems
    && overrides.fetchPersonalStatus
    && overrides.fetchPersonalConnections
    && overrides.enqueuePending
  ) {
    return overrides as IngestDeps;
  }

  const defaults = await createDeps(runtime);
  return {
    ...defaults,
    ...overrides,
  };
};

export const runIngest = async (
  runtime: CliRuntimeInput,
  input: { domains?: string },
  deps?: Partial<IngestDeps>,
): Promise<RunCliResult> => {
  const resolvedDeps = await resolveDeps(runtime, deps);
  const domains = parseDomains(input.domains);
  const nowIso = toIsoNow();
  const store = await resolvedDeps.loadStore();
  const pendingItems: PendingItemInput[] = [];
  let worldCursorUpdatedAt = store.worldCursorUpdatedAt;
  let personalSnapshotHash = store.personalSnapshotHash;

  if (domains.includes("world")) {
    for (const provider of DEFAULT_WORLD_PROVIDERS) {
      try {
        await resolvedDeps.fetchWorldHeadlines({
          provider,
          limit: String(DEFAULT_WORLD_LIMIT),
        });
      } catch {
        // best effort refresh; list below is the source of truth
      }
    }

    const worldItems = await resolvedDeps.fetchWorldItems({
      afterUpdatedAt: worldCursorUpdatedAt ?? undefined,
      limit: String(Math.max(DEFAULT_WORLD_LIMIT * 3, 50)),
      full: true,
    });

    for (const item of worldItems) {
      if (item.updatedAt && (!worldCursorUpdatedAt || item.updatedAt > worldCursorUpdatedAt)) {
        worldCursorUpdatedAt = item.updatedAt;
      }
      const pending = toWorldPendingItem(item, nowIso);
      if (pending) pendingItems.push(pending);
    }
  }

  if (domains.includes("personal")) {
    try {
      const status = await resolvedDeps.fetchPersonalStatus();
      if (status.configured) {
        const connections = await resolvedDeps.fetchPersonalConnections();
        const fingerprint = toConnectionFingerprint(connections);
        if (fingerprint !== store.personalSnapshotHash) {
          personalSnapshotHash = fingerprint;
          pendingItems.push(toPersonalPendingItem(connections, fingerprint, nowIso));
        }
      }
    } catch {
      // best effort personal ingest
    }
  }

  const enqueue = await resolvedDeps.enqueuePending({
    worldCursorUpdatedAt,
    personalSnapshotHash,
    items: pendingItems,
  });

  return {
    exitCode: 0,
    stdout: okEnvelope("ingest", "run", {
      inserted: {
        world: enqueue.insertedBySource.world,
        personal: enqueue.insertedBySource.personal,
        total: enqueue.insertedCount,
      },
      pending: enqueue.pendingCount,
    }),
  };
};
