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
  goals?: Array<Record<string, unknown>>;
  constraints?: Record<string, unknown>;
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
      goals: [],
      constraints: {},
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
      ...(patch.goals !== undefined ? { goals: patch.goals } : {}),
      ...(patch.constraints !== undefined
        ? { constraints: patch.constraints }
        : {}),
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
        goals text not null default '[]',
        constraints text not null default '{}',
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

  async unsetPreference(id: string, key: string): Promise<ProfileRecord | null> {
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

  async unsetConstraint(id: string, key: string): Promise<ProfileRecord | null> {
    const profile = await this.getById(id);
    if (!profile) return null;

    const nextConstraints = { ...(profile.constraints ?? {}) };
    delete nextConstraints[key];

    return this.update(id, {
      constraints: nextConstraints,
    });
  }
}
