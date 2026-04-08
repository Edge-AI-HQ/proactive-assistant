import {
  ProfileRepository,
  type ProfileInterestRecord,
  type ProfileSnapshotContent,
  type ProfileSignalRecord,
  type RollupSignalsResult,
} from "./repository.js";
import type { ProfileRecord } from "./schema.js";

import { PinDatabaseManager, resolvePinDataRoot } from "../../db/database.js";
import type { CoreContext } from "../../context.js";
import { NotFoundError, ConflictError, ValidationError } from "../../errors.js";
import { parseJsonValue, parseSinceCutoff } from "../../validation.js";

export const DEFAULT_PROFILE_ID = "default";

const createRepository = async (ctx: CoreContext) => {
  const dataRoot = resolvePinDataRoot(ctx);
  const manager = new PinDatabaseManager({ dataRoot });
  await manager.init();
  return new ProfileRepository(manager.open("pin"));
};

const toSimpleProfile = (profile: ProfileRecord): Record<string, unknown> => ({
  id: profile.id,
  displayName: profile.displayName,
  locale: profile.locale,
  timezone: profile.timezone,
  summary: profile.summary,
});

const parseMetadata = (raw?: string): Record<string, unknown> | undefined => {
  if (!raw) return undefined;
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ValidationError("INVALID_ARGUMENT", "metadata must be a JSON object");
  }
  return parsed as Record<string, unknown>;
};

const parseOptionalFloat = (raw?: string): number | undefined => {
  if (raw === undefined) return undefined;
  const value = Number.parseFloat(raw);
  if (Number.isNaN(value)) {
    throw new ValidationError("INVALID_ARGUMENT", "value must be a number");
  }
  return value;
};

const parseJsonStringArray = (raw?: string): string[] | undefined => {
  if (!raw) return undefined;
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new ValidationError("INVALID_ARGUMENT", "tags-json must be a JSON string array");
  }
  return parsed;
};

export const createProfile = async (
  ctx: CoreContext,
  input: {
    id: string;
    displayName: string;
    locale?: string;
    timezone?: string;
    summary?: string;
    metadata?: string;
    full?: boolean;
  },
): Promise<Record<string, unknown> | ProfileRecord> => {
  const repository = await createRepository(ctx);
  try {
    const profile = await repository.create({
      id: input.id,
      displayName: input.displayName,
      locale: input.locale,
      timezone: input.timezone,
      summary: input.summary,
      metadata: parseMetadata(input.metadata),
    });

    return input.full === true ? profile : toSimpleProfile(profile);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown profile create error";

    if (message.includes("UNIQUE constraint failed")) {
      throw new ConflictError(
        "CONFLICT",
        `Profile ${input.id} already exists`,
        "run `pin profile list` to see existing profiles",
      );
    }

    throw error;
  }
};

export const getProfile = async (
  ctx: CoreContext,
  id: string,
  full = false,
): Promise<Record<string, unknown> | ProfileRecord> => {
  const repository = await createRepository(ctx);
  const profile = await repository.getById(id);

  if (!profile) {
    throw new NotFoundError(
      "NOT_FOUND",
      `Profile ${id} not found`,
      "run `pin profile list` to see available profiles",
    );
  }

  return full ? profile : toSimpleProfile(profile);
};

export const getPreferences = async (
  ctx: CoreContext,
): Promise<Record<string, unknown>> => {
  const repository = await createRepository(ctx);
  const preferences = await repository.getPreferences(DEFAULT_PROFILE_ID);

  if (!preferences) {
    throw new NotFoundError(
      "NOT_FOUND",
      "Default profile not found",
      "run `pin profile create` first",
    );
  }

  return preferences;
};

export const getFacts = async (
  ctx: CoreContext,
): Promise<Record<string, unknown>> => {
  const repository = await createRepository(ctx);
  const facts = await repository.getFacts(DEFAULT_PROFILE_ID);

  if (!facts) {
    throw new NotFoundError(
      "NOT_FOUND",
      "Default profile not found",
      "run `pin profile create` first",
    );
  }

  return facts;
};

export const setFact = async (
  ctx: CoreContext,
  input: { key: string; valueJson: string },
): Promise<Record<string, unknown>> => {
  const repository = await createRepository(ctx);
  const profile = await repository.setFact(
    DEFAULT_PROFILE_ID,
    input.key,
    parseJsonValue(input.valueJson),
  );

  if (!profile) {
    throw new NotFoundError(
      "NOT_FOUND",
      "Default profile not found",
      "run `pin profile create` first",
    );
  }

  return profile.facts ?? {};
};

export const unsetFact = async (
  ctx: CoreContext,
  key: string,
): Promise<Record<string, unknown>> => {
  const repository = await createRepository(ctx);
  const profile = await repository.unsetFact(DEFAULT_PROFILE_ID, key);

  if (!profile) {
    throw new NotFoundError(
      "NOT_FOUND",
      "Default profile not found",
      "run `pin profile create` first",
    );
  }

  return profile.facts ?? {};
};

export const setPreference = async (
  ctx: CoreContext,
  input: { key: string; valueJson: string },
): Promise<Record<string, unknown>> => {
  const repository = await createRepository(ctx);
  const profile = await repository.setPreference(
    DEFAULT_PROFILE_ID,
    input.key,
    parseJsonValue(input.valueJson),
  );

  if (!profile) {
    throw new NotFoundError(
      "NOT_FOUND",
      "Default profile not found",
      "run `pin profile create` first",
    );
  }

  return profile.preferences ?? {};
};

export const unsetPreference = async (
  ctx: CoreContext,
  key: string,
): Promise<Record<string, unknown>> => {
  const repository = await createRepository(ctx);
  const profile = await repository.unsetPreference(DEFAULT_PROFILE_ID, key);

  if (!profile) {
    throw new NotFoundError(
      "NOT_FOUND",
      "Default profile not found",
      "run `pin profile create` first",
    );
  }

  return profile.preferences ?? {};
};

export const listGoals = async (
  ctx: CoreContext,
): Promise<Array<Record<string, unknown>>> => {
  const repository = await createRepository(ctx);
  const goals = await repository.listGoals(DEFAULT_PROFILE_ID);

  if (!goals) {
    throw new NotFoundError(
      "NOT_FOUND",
      "Default profile not found",
      "run `pin profile create` first",
    );
  }

  return goals;
};

export const listMemory = async (
  ctx: CoreContext,
): Promise<Array<Record<string, unknown>>> => {
  const repository = await createRepository(ctx);
  const entries = await repository.listMemory(DEFAULT_PROFILE_ID);

  if (!entries) {
    throw new NotFoundError(
      "NOT_FOUND",
      "Default profile not found",
      "run `pin profile create` first",
    );
  }

  return entries;
};

export const addMemory = async (
  ctx: CoreContext,
  input: { kind: string; text: string; tagsJson?: string },
): Promise<Record<string, unknown>> => {
  const repository = await createRepository(ctx);
  const entry = await repository.addMemory(DEFAULT_PROFILE_ID, {
    kind: input.kind,
    text: input.text,
    tags: parseJsonStringArray(input.tagsJson),
  });

  if (!entry) {
    throw new NotFoundError(
      "NOT_FOUND",
      "Default profile not found",
      "run `pin profile create` first",
    );
  }

  return entry;
};

export const searchMemory = async (
  ctx: CoreContext,
  query: string,
): Promise<Array<Record<string, unknown>>> => {
  const repository = await createRepository(ctx);
  const entries = await repository.searchMemory(DEFAULT_PROFILE_ID, query);

  if (!entries) {
    throw new NotFoundError(
      "NOT_FOUND",
      "Default profile not found",
      "run `pin profile create` first",
    );
  }

  return entries;
};

export const removeMemory = async (
  ctx: CoreContext,
  entryId: string,
): Promise<{ id: string; deleted: true }> => {
  const repository = await createRepository(ctx);
  const removed = await repository.removeMemory(DEFAULT_PROFILE_ID, entryId);

  if (removed === null) {
    throw new NotFoundError(
      "NOT_FOUND",
      "Default profile not found",
      "run `pin profile create` first",
    );
  }

  if (removed === false) {
    throw new NotFoundError(
      "NOT_FOUND",
      `Memory ${entryId} not found`,
    );
  }

  return { id: entryId, deleted: true };
};

export const upsertGoal = async (
  ctx: CoreContext,
  input: { key: string; title: string; priority?: string; summary?: string },
): Promise<Array<Record<string, unknown>>> => {
  const repository = await createRepository(ctx);
  const profile = await repository.upsertGoal(DEFAULT_PROFILE_ID, input);

  if (!profile) {
    throw new NotFoundError(
      "NOT_FOUND",
      "Default profile not found",
      "run `pin profile create` first",
    );
  }

  return (profile.goals ?? []) as Array<Record<string, unknown>>;
};

export const closeGoal = async (
  ctx: CoreContext,
  key: string,
): Promise<Array<Record<string, unknown>>> => {
  const repository = await createRepository(ctx);
  const profile = await repository.closeGoal(DEFAULT_PROFILE_ID, key);

  if (!profile) {
    throw new NotFoundError(
      "NOT_FOUND",
      "Default profile not found",
      "run `pin profile create` first",
    );
  }

  return (profile.goals ?? []) as Array<Record<string, unknown>>;
};

export const getConstraints = async (
  ctx: CoreContext,
): Promise<Record<string, unknown>> => {
  const repository = await createRepository(ctx);
  const constraints = await repository.getConstraints(DEFAULT_PROFILE_ID);

  if (!constraints) {
    throw new NotFoundError(
      "NOT_FOUND",
      "Default profile not found",
      "run `pin profile create` first",
    );
  }

  return constraints;
};

export const setConstraint = async (
  ctx: CoreContext,
  input: { key: string; valueJson: string },
): Promise<Record<string, unknown>> => {
  const repository = await createRepository(ctx);
  const profile = await repository.setConstraint(
    DEFAULT_PROFILE_ID,
    input.key,
    parseJsonValue(input.valueJson),
  );

  if (!profile) {
    throw new NotFoundError(
      "NOT_FOUND",
      "Default profile not found",
      "run `pin profile create` first",
    );
  }

  return profile.constraints ?? {};
};

export const unsetConstraint = async (
  ctx: CoreContext,
  key: string,
): Promise<Record<string, unknown>> => {
  const repository = await createRepository(ctx);
  const profile = await repository.unsetConstraint(DEFAULT_PROFILE_ID, key);

  if (!profile) {
    throw new NotFoundError(
      "NOT_FOUND",
      "Default profile not found",
      "run `pin profile create` first",
    );
  }

  return profile.constraints ?? {};
};

export const listProfiles = async (
  ctx: CoreContext,
  full = false,
): Promise<Array<Record<string, unknown> | ProfileRecord>> => {
  const repository = await createRepository(ctx);
  const profiles = await repository.list();

  return full ? profiles : profiles.map((profile) => toSimpleProfile(profile));
};

export const updateProfile = async (
  ctx: CoreContext,
  input: {
    id: string;
    displayName?: string;
    locale?: string;
    timezone?: string;
    summary?: string;
    metadata?: string;
  },
): Promise<ProfileRecord> => {
  const repository = await createRepository(ctx);
  const profile = await repository.update(input.id, {
    ...(input.displayName !== undefined
      ? { displayName: input.displayName }
      : {}),
    ...(input.locale !== undefined ? { locale: input.locale } : {}),
    ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    ...(input.metadata !== undefined
      ? { metadata: parseMetadata(input.metadata) }
      : {}),
  });

  if (!profile) {
    throw new NotFoundError(
      "NOT_FOUND",
      `Profile ${input.id} not found`,
      "run `pin profile list` to see available profiles",
    );
  }

  return profile;
};

export const addProfileSignal = async (
  ctx: CoreContext,
  input: {
    id: string;
    kind: string;
    targetType: string;
    targetKey: string;
    value?: string;
    source: string;
    occurredAt?: string;
  },
): Promise<ProfileSignalRecord> => {
  const repository = await createRepository(ctx);
  const signal = await repository.addSignal(input.id, {
    kind: input.kind,
    targetType: input.targetType,
    targetKey: input.targetKey,
    value: parseOptionalFloat(input.value),
    source: input.source,
    occurredAt: input.occurredAt,
  });

  if (!signal) {
    throw new NotFoundError(
      "NOT_FOUND",
      `Profile ${input.id} not found`,
      "run `pin profile list` to see available profiles",
    );
  }

  return signal;
};

export const rollupProfileSignals = async (
  ctx: CoreContext,
  input: {
    id: string;
    since?: string;
  },
): Promise<RollupSignalsResult> => {
  const repository = await createRepository(ctx);
  const result = await repository.rollupSignals(input.id, {
    since: parseSinceCutoff(input.since),
  });

  if (!result) {
    throw new NotFoundError(
      "NOT_FOUND",
      `Profile ${input.id} not found`,
      "run `pin profile list` to see available profiles",
    );
  }

  return result;
};

export const listProfileInterests = async (
  ctx: CoreContext,
  input: {
    id: string;
    kind?: string;
    limit?: string;
  },
): Promise<ProfileInterestRecord[]> => {
  const repository = await createRepository(ctx);
  const profile = await repository.getById(input.id);

  if (!profile) {
    throw new NotFoundError(
      "NOT_FOUND",
      `Profile ${input.id} not found`,
      "run `pin profile list` to see available profiles",
    );
  }

  const limit = Number.parseInt(input.limit ?? "20", 10);
  const interests = await repository.listInterests(input.id, {
    kind: input.kind,
    limit: Number.isNaN(limit) ? 20 : limit,
  });

  return interests;
};

export const buildProfileSnapshot = async (
  ctx: CoreContext,
  input: {
    id: string;
    view: string;
  },
): Promise<ProfileSnapshotContent> => {
  const repository = await createRepository(ctx);
  const snapshot = await repository.buildSnapshot(input.id, input.view);

  if (!snapshot) {
    throw new NotFoundError(
      "NOT_FOUND",
      `Profile ${input.id} not found`,
      "run `pin profile list` to see available profiles",
    );
  }

  return snapshot;
};

export const deleteProfile = async (
  ctx: CoreContext,
  id: string,
): Promise<{ id: string; deleted: true }> => {
  const repository = await createRepository(ctx);
  const deleted = await repository.delete(id);

  if (!deleted) {
    throw new NotFoundError(
      "NOT_FOUND",
      `Profile ${id} not found`,
      "run `pin profile list` to see available profiles",
    );
  }

  return { id, deleted: true };
};
