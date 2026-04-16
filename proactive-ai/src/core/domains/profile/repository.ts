import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import type { SqliteDatabase } from "../../db/sqlite_adapter.js";
import {
  profiles,
  type NewProfileRecord,
  type ProfileRecord,
} from "./schema.js";

export interface CreateProfileInput {
  id: string;
  displayName: string;
  locale?: string;
  timezone?: string;
  summary?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateProfileInput {
  displayName?: string;
  locale?: string | null;
  timezone?: string | null;
  summary?: string | null;
  facts?: Record<string, unknown>;
  preferences?: Record<string, unknown>;
  memory?: Array<Record<string, unknown>>;
  goals?: Array<Record<string, unknown>>;
  constraints?: Record<string, unknown>;
  signals?: Array<Record<string, unknown>>;
  interests?: Array<Record<string, unknown>>;
  snapshots?: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
}

export interface ProfileGoalRecord extends Record<string, unknown> {
  key: string;
  title: string;
  status: string;
  priority?: string;
  closedAt?: string | null;
  summary?: string | null;
}

export interface ProfileMemoryRecord extends Record<string, unknown> {
  id: string;
  kind: string;
  text: string;
  tags?: string[];
  createdAt: string;
}

export interface ProfileSignalRecord extends Record<string, unknown> {
  id: string;
  kind: string;
  targetType: string;
  targetKey: string;
  value: number;
  source: string;
  occurredAt: string;
  context?: Record<string, unknown>;
}

export interface ProfileInterestRecord extends Record<string, unknown> {
  id: string;
  kind: string;
  key: string;
  score: number;
  confidence: number;
  evidenceCount: number;
  lastSignalAt: string;
  status: string;
}

export interface ProfileSnapshotContent extends Record<string, unknown> {
  profileId: string;
  view: string;
  topPositiveTopics: Array<{
    key: string;
    score: number;
    evidenceCount: number;
    facts: Array<{ code: string; value: string | number }>;
  }>;
  topNegativeTopics: Array<{
    key: string;
    score: number;
    evidenceCount: number;
    facts: Array<{ code: string; value: string | number }>;
  }>;
  topEntities: Array<{
    key: string;
    score: number;
    evidenceCount: number;
    facts: Array<{ code: string; value: string | number }>;
  }>;
  activeConstraints: Array<{
    key: string;
    facts: Array<{ code: string; value: string }>;
  }>;
}

export interface RollupSignalsResult {
  signalsProcessed: number;
  interestsUpdated: number;
}

interface AddSignalInput {
  kind: string;
  targetType: string;
  targetKey: string;
  value?: number;
  source: string;
  occurredAt?: string;
  context?: Record<string, unknown>;
}

const nextRecordId = (prefix: string): string =>
  `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

const BASE_SIGNAL_WEIGHTS: Record<string, number> = {
  liked: 1,
  disliked: -1.2,
  shared: 0.9,
  followed_up: 0.8,
  saved: 0.7,
  clicked: 0.5,
  opened: 0.3,
  searched: 0.25,
  skipped: -0.2,
  dismissed: -0.5,
};

const SOURCE_WEIGHTS: Record<string, number> = {
  explicit: 1,
  implicit: 0.7,
  agent: 0.4,
};

const getBaseSignalWeight = (kind: string): number =>
  BASE_SIGNAL_WEIGHTS[kind] ?? 0;

const getSourceWeight = (source: string): number => SOURCE_WEIGHTS[source] ?? 1;

const getDecayMultiplier = (occurredAt: string): number => {
  const ageMs = Math.max(0, Date.now() - new Date(occurredAt).getTime());
  const days = ageMs / (1000 * 60 * 60 * 24);
  return Math.exp(-days / 14);
};

const toInterestScore = (raw: number): number => Math.tanh(raw);

const toInterestConfidence = (evidenceCount: number): number =>
  Math.min(1, Math.sqrt(evidenceCount) / 3);

export class ProfileRepository {
  private schemaReady = false;

  constructor(private readonly database: SqliteDatabase) {}

  async create(input: CreateProfileInput): Promise<ProfileRecord> {
    await this.ensureSchema();

    const now = new Date().toISOString();
    const values: NewProfileRecord = {
      id: input.id,
      displayName: input.displayName,
      locale: input.locale ?? null,
      timezone: input.timezone ?? null,
      summary: input.summary ?? null,
      facts: {},
      preferences: {},
      memory: [],
      goals: [],
      constraints: {},
      signals: [],
      interests: [],
      snapshots: [],
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };

    this.database.orm.insert(profiles).values(values).run();
    return (await this.getById(input.id)) as ProfileRecord;
  }

  async getById(id: string): Promise<ProfileRecord | null> {
    await this.ensureSchema();
    const result = this.database.orm
      .select()
      .from(profiles)
      .where(eq(profiles.id, id))
      .limit(1)
      .all();

    return result[0] ?? null;
  }

  async list(): Promise<ProfileRecord[]> {
    await this.ensureSchema();
    return this.database.orm.select().from(profiles).orderBy(profiles.id).all();
  }

  async update(
    id: string,
    patch: UpdateProfileInput,
  ): Promise<ProfileRecord | null> {
    await this.ensureSchema();

    const values = {
      ...(patch.displayName !== undefined
        ? { displayName: patch.displayName }
        : {}),
      ...(patch.locale !== undefined ? { locale: patch.locale } : {}),
      ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      ...(patch.facts !== undefined ? { facts: patch.facts } : {}),
      ...(patch.preferences !== undefined
        ? { preferences: patch.preferences }
        : {}),
      ...(patch.memory !== undefined ? { memory: patch.memory } : {}),
      ...(patch.goals !== undefined ? { goals: patch.goals } : {}),
      ...(patch.constraints !== undefined
        ? { constraints: patch.constraints }
        : {}),
      ...(patch.signals !== undefined ? { signals: patch.signals } : {}),
      ...(patch.interests !== undefined ? { interests: patch.interests } : {}),
      ...(patch.snapshots !== undefined ? { snapshots: patch.snapshots } : {}),
      ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
      updatedAt: new Date().toISOString(),
    };

    if (Object.keys(values).length === 1) {
      return this.getById(id);
    }

    const result = this.database.orm
      .update(profiles)
      .set(values)
      .where(eq(profiles.id, id))
      .returning()
      .all();

    return result[0] ?? null;
  }

  async delete(id: string): Promise<boolean> {
    await this.ensureSchema();
    const result = this.database.orm
      .delete(profiles)
      .where(eq(profiles.id, id))
      .returning({ id: profiles.id })
      .all();

    return result.length > 0;
  }

  private async ensureSchema(): Promise<void> {
    if (this.schemaReady) {
      return;
    }

    this.database.exec(`
      create table if not exists profiles (
        id text primary key not null,
        display_name text not null,
        locale text,
        timezone text,
        summary text,
        facts text not null default '{}',
        preferences text not null default '{}',
        memory text not null default '[]',
        goals text not null default '[]',
        constraints text not null default '{}',
        signals text not null default '[]',
        interests text not null default '[]',
        snapshots text not null default '[]',
        metadata text not null default '{}',
        created_at text not null,
        updated_at text not null
      )
    `);

    const columns = this.database.all<{ name: string }>(
      "pragma table_info(profiles)",
    );
    const columnNames = new Set(columns.map((column) => column.name));

    if (!columnNames.has("facts")) {
      this.database.exec(
        "alter table profiles add column facts text not null default '{}'",
      );
    }

    if (!columnNames.has("preferences")) {
      this.database.exec(
        "alter table profiles add column preferences text not null default '{}'",
      );
    }

    if (!columnNames.has("memory")) {
      this.database.exec(
        "alter table profiles add column memory text not null default '[]'",
      );
    }

    if (!columnNames.has("goals")) {
      this.database.exec(
        "alter table profiles add column goals text not null default '[]'",
      );
    }

    if (!columnNames.has("constraints")) {
      this.database.exec(
        "alter table profiles add column constraints text not null default '{}'",
      );
    }

    if (!columnNames.has("signals")) {
      this.database.exec(
        "alter table profiles add column signals text not null default '[]'",
      );
    }

    if (!columnNames.has("interests")) {
      this.database.exec(
        "alter table profiles add column interests text not null default '[]'",
      );
    }

    if (!columnNames.has("snapshots")) {
      this.database.exec(
        "alter table profiles add column snapshots text not null default '[]'",
      );
    }

    this.database.exec(`
      create table if not exists connector_raw_data (
        id text primary key not null,
        profile_id text not null,
        connector_kind text not null default 'composio',
        toolkit text not null,
        connected_account_id text,
        tool_slug text,
        ingest_source text not null default 'profile_ingest',
        window_label text,
        captured_at text not null,
        payload_json text not null,
        created_at text not null
      )
    `);
    this.database.exec(`
      create index if not exists connector_raw_data_profile_created_idx
      on connector_raw_data (profile_id, created_at desc)
    `);
    this.database.exec(`
      create index if not exists connector_raw_data_profile_toolkit_captured_idx
      on connector_raw_data (profile_id, toolkit, captured_at desc)
    `);

    this.schemaReady = true;
  }

  async getPreferences(id: string): Promise<Record<string, unknown> | null> {
    const profile = await this.getById(id);
    return profile ? (profile.preferences ?? {}) : null;
  }

  async getFacts(id: string): Promise<Record<string, unknown> | null> {
    const profile = await this.getById(id);
    return profile ? (profile.facts ?? {}) : null;
  }

  async setFact(
    id: string,
    key: string,
    value: unknown,
  ): Promise<ProfileRecord | null> {
    const profile = await this.getById(id);
    if (!profile) return null;

    return this.update(id, {
      facts: {
        ...(profile.facts ?? {}),
        [key]: value,
      },
    });
  }

  async unsetFact(id: string, key: string): Promise<ProfileRecord | null> {
    const profile = await this.getById(id);
    if (!profile) return null;

    const nextFacts = { ...(profile.facts ?? {}) };
    delete nextFacts[key];

    return this.update(id, {
      facts: nextFacts,
    });
  }

  async setPreference(
    id: string,
    key: string,
    value: unknown,
  ): Promise<ProfileRecord | null> {
    const profile = await this.getById(id);
    if (!profile) return null;

    return this.update(id, {
      preferences: {
        ...(profile.preferences ?? {}),
        [key]: value,
      },
    });
  }

  async unsetPreference(
    id: string,
    key: string,
  ): Promise<ProfileRecord | null> {
    const profile = await this.getById(id);
    if (!profile) return null;

    const nextPreferences = { ...(profile.preferences ?? {}) };
    delete nextPreferences[key];

    return this.update(id, {
      preferences: nextPreferences,
    });
  }

  async listGoals(id: string): Promise<ProfileGoalRecord[] | null> {
    const profile = await this.getById(id);
    return profile ? ((profile.goals ?? []) as ProfileGoalRecord[]) : null;
  }

  async listMemory(id: string): Promise<ProfileMemoryRecord[] | null> {
    const profile = await this.getById(id);
    return profile ? ((profile.memory ?? []) as ProfileMemoryRecord[]) : null;
  }

  async addMemory(
    id: string,
    input: {
      kind: string;
      text: string;
      tags?: string[];
    },
  ): Promise<ProfileMemoryRecord | null> {
    const profile = await this.getById(id);
    if (!profile) return null;

    const entry: ProfileMemoryRecord = {
      id: Math.random().toString(36).slice(2, 10),
      kind: input.kind,
      text: input.text,
      tags: input.tags ?? [],
      createdAt: new Date().toISOString(),
    };

    await this.update(id, {
      memory: [...(profile.memory ?? []), entry],
    });

    return entry;
  }

  async searchMemory(
    id: string,
    query: string,
  ): Promise<ProfileMemoryRecord[] | null> {
    const entries = await this.listMemory(id);
    if (!entries) return null;

    const normalizedQuery = query.trim().toLowerCase();
    return entries.filter((entry) => {
      const haystack = [
        entry.kind,
        entry.text,
        ...(Array.isArray(entry.tags) ? entry.tags : []),
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(normalizedQuery);
    });
  }

  async removeMemory(id: string, entryId: string): Promise<boolean | null> {
    const profile = await this.getById(id);
    if (!profile) return null;

    const currentMemory = (profile.memory ?? []) as ProfileMemoryRecord[];
    const nextMemory = currentMemory.filter((entry) => entry.id !== entryId);

    if (nextMemory.length === currentMemory.length) {
      return false;
    }

    await this.update(id, {
      memory: nextMemory,
    });

    return true;
  }

  async upsertGoal(
    id: string,
    input: {
      key: string;
      title: string;
      priority?: string;
      summary?: string;
    },
  ): Promise<ProfileRecord | null> {
    const profile = await this.getById(id);
    if (!profile) return null;

    const currentGoals = (profile.goals ?? []) as ProfileGoalRecord[];
    const now = new Date().toISOString();
    const nextGoal: ProfileGoalRecord = {
      key: input.key,
      title: input.title,
      priority: input.priority,
      summary: input.summary ?? null,
      status: "active",
      closedAt: null,
      updatedAt: now,
    };

    const nextGoals = currentGoals.some((goal) => goal.key === input.key)
      ? currentGoals.map((goal) => (goal.key === input.key ? nextGoal : goal))
      : [...currentGoals, nextGoal];

    return this.update(id, {
      goals: nextGoals,
    });
  }

  async closeGoal(id: string, key: string): Promise<ProfileRecord | null> {
    const profile = await this.getById(id);
    if (!profile) return null;

    const currentGoals = (profile.goals ?? []) as ProfileGoalRecord[];
    const now = new Date().toISOString();
    const nextGoals = currentGoals.map((goal) =>
      goal.key === key
        ? {
            ...goal,
            status: "closed",
            closedAt: now,
            updatedAt: now,
          }
        : goal,
    );

    return this.update(id, {
      goals: nextGoals,
    });
  }

  async getConstraints(id: string): Promise<Record<string, unknown> | null> {
    const profile = await this.getById(id);
    return profile ? (profile.constraints ?? {}) : null;
  }

  async setConstraint(
    id: string,
    key: string,
    value: unknown,
  ): Promise<ProfileRecord | null> {
    const profile = await this.getById(id);
    if (!profile) return null;

    return this.update(id, {
      constraints: {
        ...(profile.constraints ?? {}),
        [key]: value,
      },
    });
  }

  async unsetConstraint(
    id: string,
    key: string,
  ): Promise<ProfileRecord | null> {
    const profile = await this.getById(id);
    if (!profile) return null;

    const nextConstraints = { ...(profile.constraints ?? {}) };
    delete nextConstraints[key];

    return this.update(id, {
      constraints: nextConstraints,
    });
  }

  async addSignal(
    id: string,
    input: AddSignalInput,
  ): Promise<ProfileSignalRecord | null> {
    const profile = await this.getById(id);
    if (!profile) return null;

    const signal: ProfileSignalRecord = {
      id: nextRecordId("sig"),
      kind: input.kind,
      targetType: input.targetType,
      targetKey: input.targetKey,
      value: input.value ?? 1,
      source: input.source,
      occurredAt: input.occurredAt ?? new Date().toISOString(),
      context: input.context ?? {},
    };

    await this.update(id, {
      signals: [...((profile.signals ?? []) as ProfileSignalRecord[]), signal],
    });

    return signal;
  }

  async listSignals(id: string): Promise<ProfileSignalRecord[] | null> {
    const profile = await this.getById(id);
    return profile ? ((profile.signals ?? []) as ProfileSignalRecord[]) : null;
  }

  async rollupSignals(
    id: string,
    options?: { since?: string },
  ): Promise<RollupSignalsResult | null> {
    const profile = await this.getById(id);
    if (!profile) return null;

    const signals = ((profile.signals ?? []) as ProfileSignalRecord[]).filter(
      (signal) => (options?.since ? signal.occurredAt >= options.since : true),
    );

    const aggregates = new Map<
      string,
      {
        kind: string;
        key: string;
        rawScore: number;
        evidenceCount: number;
        lastSignalAt: string;
      }
    >();

    for (const signal of signals) {
      const aggregateKey = `${signal.targetType}:${signal.targetKey}`;
      const current = aggregates.get(aggregateKey) ?? {
        kind: signal.targetType,
        key: signal.targetKey,
        rawScore: 0,
        evidenceCount: 0,
        lastSignalAt: signal.occurredAt,
      };
      current.rawScore +=
        getBaseSignalWeight(signal.kind) *
        getSourceWeight(signal.source) *
        signal.value *
        getDecayMultiplier(signal.occurredAt);
      current.evidenceCount += 1;
      if (signal.occurredAt > current.lastSignalAt) {
        current.lastSignalAt = signal.occurredAt;
      }
      aggregates.set(aggregateKey, current);
    }

    const nextInterests: ProfileInterestRecord[] = [...aggregates.values()]
      .map((entry) => ({
        id: nextRecordId("interest"),
        kind: entry.kind,
        key: entry.key,
        score: Number(toInterestScore(entry.rawScore).toFixed(4)),
        confidence: Number(
          toInterestConfidence(entry.evidenceCount).toFixed(4),
        ),
        evidenceCount: entry.evidenceCount,
        lastSignalAt: entry.lastSignalAt,
        status: entry.rawScore <= -0.75 ? "suppressed" : "active",
      }))
      .sort((left, right) => {
        const scoreDiff = right.score - left.score;
        if (scoreDiff !== 0) return scoreDiff;
        return left.key.localeCompare(right.key);
      });

    await this.update(id, {
      interests: nextInterests,
    });

    return {
      signalsProcessed: signals.length,
      interestsUpdated: nextInterests.length,
    };
  }

  async listInterests(
    id: string,
    options?: { kind?: string; limit?: number },
  ): Promise<ProfileInterestRecord[]> {
    const profile = await this.getById(id);
    if (!profile) return [];

    return ((profile.interests ?? []) as ProfileInterestRecord[])
      .filter((interest) =>
        options?.kind ? interest.kind === options.kind : true,
      )
      .slice(0, options?.limit ?? 20);
  }

  async buildSnapshot(
    id: string,
    view: string,
  ): Promise<ProfileSnapshotContent | null> {
    const profile = await this.getById(id);
    if (!profile) return null;

    const interests = (
      (profile.interests ?? []) as ProfileInterestRecord[]
    ).sort((left, right) => right.score - left.score);
    const positiveTopics = interests
      .filter((interest) => interest.kind === "topic" && interest.score > 0)
      .slice(0, 3)
      .map((interest) => ({
        key: interest.key,
        score: interest.score,
        evidenceCount: interest.evidenceCount,
        facts: [
          { code: "INTEREST_SCORE", value: interest.score },
          { code: "EVIDENCE_COUNT", value: interest.evidenceCount },
        ],
      }));
    const negativeTopics = interests
      .filter((interest) => interest.kind === "topic" && interest.score < 0)
      .sort((left, right) => left.score - right.score)
      .slice(0, 3)
      .map((interest) => ({
        key: interest.key,
        score: interest.score,
        evidenceCount: interest.evidenceCount,
        facts: [
          { code: "INTEREST_SCORE", value: interest.score },
          { code: "EVIDENCE_COUNT", value: interest.evidenceCount },
        ],
      }));
    const topEntities = interests
      .filter((interest) => interest.kind === "entity" && interest.score > 0)
      .slice(0, 3)
      .map((interest) => ({
        key: interest.key,
        score: interest.score,
        evidenceCount: interest.evidenceCount,
        facts: [
          { code: "INTEREST_SCORE", value: interest.score },
          { code: "EVIDENCE_COUNT", value: interest.evidenceCount },
        ],
      }));
    const activeConstraints = Object.keys(
      (profile.constraints ?? {}) as Record<string, unknown>,
    )
      .sort()
      .map((key) => ({
        key,
        facts: [{ code: "CONSTRAINT_ACTIVE", value: key }],
      }));

    const snapshot: ProfileSnapshotContent = {
      profileId: id,
      view,
      topPositiveTopics: positiveTopics,
      topNegativeTopics: negativeTopics,
      topEntities,
      activeConstraints,
    };

    const currentSnapshots = (profile.snapshots ?? []) as Array<
      Record<string, unknown>
    >;
    const nextSnapshots = [
      ...currentSnapshots.filter((entry) => entry.view !== view),
      {
        ...snapshot,
        generatedAt: new Date().toISOString(),
      },
    ];

    await this.update(id, {
      snapshots: nextSnapshots,
    });

    return snapshot;
  }

  /**
   * Append bounded connector payload (Composio or future kinds) for audit — not `profiles.memory`.
   */
  async insertConnectorRawData(
    profileId: string,
    input: {
      connectorKind?: string;
      toolkit: string;
      connectedAccountId?: string;
      toolSlug?: string;
      ingestSource?: string;
      windowLabel?: string;
      capturedAt?: string;
      payloadJson: string;
    },
  ): Promise<string | null> {
    await this.ensureSchema();
    const profile = await this.getById(profileId);
    if (!profile) return null;

    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const capturedAt = input.capturedAt ?? createdAt;
    const connectorKind =
      (input.connectorKind ?? "composio").trim() || "composio";
    const ingestSource =
      (input.ingestSource ?? "profile_ingest").trim() || "profile_ingest";
    this.database.client
      .prepare(
        `insert into connector_raw_data (
          id, profile_id, connector_kind, toolkit, connected_account_id, tool_slug,
          ingest_source, window_label, captured_at, payload_json, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        profileId,
        connectorKind,
        input.toolkit,
        input.connectedAccountId?.trim() ?? null,
        input.toolSlug?.trim() ?? null,
        ingestSource,
        input.windowLabel?.trim() ?? null,
        capturedAt,
        input.payloadJson,
        createdAt,
      );

    return id;
  }
}
