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
  metadata?: Record<string, unknown>;
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
        metadata text not null default '{}',
        created_at text not null,
        updated_at text not null
      )
    `);

    this.schemaReady = true;
  }
}
