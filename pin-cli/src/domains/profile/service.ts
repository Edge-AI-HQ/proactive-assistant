import { ProfileRepository } from "./repository.js";
import type { ProfileRecord } from "./schema.js";

import { PinDatabaseManager } from "../../db/database.js";
import { errorEnvelope, okEnvelope } from "../../output/envelope.js";
import type { CliRuntimeInput, RunCliResult } from "../../runtime.js";

const parseMetadata = (raw?: string): Record<string, unknown> | undefined => {
  if (!raw) return undefined;
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("metadata must be a JSON object");
  }
  return parsed as Record<string, unknown>;
};

const createRepository = async (runtime: CliRuntimeInput) => {
  const dataRoot = runtime.env.PIN_DATA_ROOT || `${runtime.homeDir}/.pin`;
  const manager = new PinDatabaseManager({ dataRoot });
  await manager.init();
  return new ProfileRepository(manager.open("pin"));
};

const DEFAULT_PROFILE_ID = "default";

const parseJsonValue = (raw: string): unknown => JSON.parse(raw);

export const createProfile = async (
  runtime: CliRuntimeInput,
  input: {
    id: string;
    displayName: string;
    locale?: string;
    timezone?: string;
    summary?: string;
    metadata?: string;
  },
) => {
  const repository = await createRepository(runtime);
  try {
    const profile = await repository.create({
      id: input.id,
      displayName: input.displayName,
      locale: input.locale,
      timezone: input.timezone,
      summary: input.summary,
      metadata: parseMetadata(input.metadata),
    });

    return {
      exitCode: 0,
      stdout: okEnvelope<ProfileRecord>("profile", "create", profile),
    } satisfies RunCliResult;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown profile create error";

    if (message.includes("UNIQUE constraint failed")) {
      return {
        exitCode: 5,
        stdout: errorEnvelope(
          "profile",
          "create",
          "CONFLICT",
          `Profile ${input.id} already exists`,
        ),
      } satisfies RunCliResult;
    }

    throw error;
  }
};

export const getProfile = async (
  runtime: CliRuntimeInput,
  id: string,
) => {
  const repository = await createRepository(runtime);
  const profile = await repository.getById(id);

  if (!profile) {
    return {
      exitCode: 4,
      stdout: errorEnvelope("profile", "get", "NOT_FOUND", `Profile ${id} not found`),
    } satisfies RunCliResult;
  }

  return {
    exitCode: 0,
    stdout: okEnvelope<ProfileRecord>("profile", "get", profile),
  } satisfies RunCliResult;
};

export const getPreferences = async (runtime: CliRuntimeInput) => {
  const repository = await createRepository(runtime);
  const preferences = await repository.getPreferences(DEFAULT_PROFILE_ID);

  if (!preferences) {
    return {
      exitCode: 4,
      stdout: errorEnvelope("profile.preferences", "get", "NOT_FOUND", "Default profile not found"),
    } satisfies RunCliResult;
  }

  return {
    exitCode: 0,
    stdout: okEnvelope("profile.preferences", "get", preferences),
  } satisfies RunCliResult;
};

export const getFacts = async (runtime: CliRuntimeInput) => {
  const repository = await createRepository(runtime);
  const facts = await repository.getFacts(DEFAULT_PROFILE_ID);

  if (!facts) {
    return {
      exitCode: 4,
      stdout: errorEnvelope("profile.facts", "get", "NOT_FOUND", "Default profile not found"),
    } satisfies RunCliResult;
  }

  return {
    exitCode: 0,
    stdout: okEnvelope("profile.facts", "get", facts),
  } satisfies RunCliResult;
};

export const setFact = async (
  runtime: CliRuntimeInput,
  input: { key: string; valueJson: string },
) => {
  const repository = await createRepository(runtime);
  const profile = await repository.setFact(
    DEFAULT_PROFILE_ID,
    input.key,
    parseJsonValue(input.valueJson),
  );

  if (!profile) {
    return {
      exitCode: 4,
      stdout: errorEnvelope("profile.facts", "set", "NOT_FOUND", "Default profile not found"),
    } satisfies RunCliResult;
  }

  return {
    exitCode: 0,
    stdout: okEnvelope("profile.facts", "set", profile.facts ?? {}),
  } satisfies RunCliResult;
};

export const unsetFact = async (
  runtime: CliRuntimeInput,
  key: string,
) => {
  const repository = await createRepository(runtime);
  const profile = await repository.unsetFact(DEFAULT_PROFILE_ID, key);

  if (!profile) {
    return {
      exitCode: 4,
      stdout: errorEnvelope("profile.facts", "unset", "NOT_FOUND", "Default profile not found"),
    } satisfies RunCliResult;
  }

  return {
    exitCode: 0,
    stdout: okEnvelope("profile.facts", "unset", profile.facts ?? {}),
  } satisfies RunCliResult;
};

export const setPreference = async (
  runtime: CliRuntimeInput,
  input: { key: string; valueJson: string },
) => {
  const repository = await createRepository(runtime);
  const profile = await repository.setPreference(
    DEFAULT_PROFILE_ID,
    input.key,
    parseJsonValue(input.valueJson),
  );

  if (!profile) {
    return {
      exitCode: 4,
      stdout: errorEnvelope("profile.preferences", "set", "NOT_FOUND", "Default profile not found"),
    } satisfies RunCliResult;
  }

  return {
    exitCode: 0,
    stdout: okEnvelope("profile.preferences", "set", profile.preferences ?? {}),
  } satisfies RunCliResult;
};

export const unsetPreference = async (
  runtime: CliRuntimeInput,
  key: string,
) => {
  const repository = await createRepository(runtime);
  const profile = await repository.unsetPreference(DEFAULT_PROFILE_ID, key);

  if (!profile) {
    return {
      exitCode: 4,
      stdout: errorEnvelope("profile.preferences", "unset", "NOT_FOUND", "Default profile not found"),
    } satisfies RunCliResult;
  }

  return {
    exitCode: 0,
    stdout: okEnvelope("profile.preferences", "unset", profile.preferences ?? {}),
  } satisfies RunCliResult;
};

export const listGoals = async (runtime: CliRuntimeInput) => {
  const repository = await createRepository(runtime);
  const goals = await repository.listGoals(DEFAULT_PROFILE_ID);

  if (!goals) {
    return {
      exitCode: 4,
      stdout: errorEnvelope("profile.goals", "list", "NOT_FOUND", "Default profile not found"),
    } satisfies RunCliResult;
  }

  return {
    exitCode: 0,
    stdout: okEnvelope("profile.goals", "list", goals),
  } satisfies RunCliResult;
};

export const upsertGoal = async (
  runtime: CliRuntimeInput,
  input: { key: string; title: string; priority?: string; summary?: string },
) => {
  const repository = await createRepository(runtime);
  const profile = await repository.upsertGoal(DEFAULT_PROFILE_ID, input);

  if (!profile) {
    return {
      exitCode: 4,
      stdout: errorEnvelope("profile.goals", "upsert", "NOT_FOUND", "Default profile not found"),
    } satisfies RunCliResult;
  }

  return {
    exitCode: 0,
    stdout: okEnvelope("profile.goals", "upsert", profile.goals ?? []),
  } satisfies RunCliResult;
};

export const closeGoal = async (
  runtime: CliRuntimeInput,
  key: string,
) => {
  const repository = await createRepository(runtime);
  const profile = await repository.closeGoal(DEFAULT_PROFILE_ID, key);

  if (!profile) {
    return {
      exitCode: 4,
      stdout: errorEnvelope("profile.goals", "close", "NOT_FOUND", "Default profile not found"),
    } satisfies RunCliResult;
  }

  return {
    exitCode: 0,
    stdout: okEnvelope("profile.goals", "close", profile.goals ?? []),
  } satisfies RunCliResult;
};

export const getConstraints = async (runtime: CliRuntimeInput) => {
  const repository = await createRepository(runtime);
  const constraints = await repository.getConstraints(DEFAULT_PROFILE_ID);

  if (!constraints) {
    return {
      exitCode: 4,
      stdout: errorEnvelope("profile.constraints", "get", "NOT_FOUND", "Default profile not found"),
    } satisfies RunCliResult;
  }

  return {
    exitCode: 0,
    stdout: okEnvelope("profile.constraints", "get", constraints),
  } satisfies RunCliResult;
};

export const setConstraint = async (
  runtime: CliRuntimeInput,
  input: { key: string; valueJson: string },
) => {
  const repository = await createRepository(runtime);
  const profile = await repository.setConstraint(
    DEFAULT_PROFILE_ID,
    input.key,
    parseJsonValue(input.valueJson),
  );

  if (!profile) {
    return {
      exitCode: 4,
      stdout: errorEnvelope("profile.constraints", "set", "NOT_FOUND", "Default profile not found"),
    } satisfies RunCliResult;
  }

  return {
    exitCode: 0,
    stdout: okEnvelope("profile.constraints", "set", profile.constraints ?? {}),
  } satisfies RunCliResult;
};

export const unsetConstraint = async (
  runtime: CliRuntimeInput,
  key: string,
) => {
  const repository = await createRepository(runtime);
  const profile = await repository.unsetConstraint(DEFAULT_PROFILE_ID, key);

  if (!profile) {
    return {
      exitCode: 4,
      stdout: errorEnvelope("profile.constraints", "unset", "NOT_FOUND", "Default profile not found"),
    } satisfies RunCliResult;
  }

  return {
    exitCode: 0,
    stdout: okEnvelope("profile.constraints", "unset", profile.constraints ?? {}),
  } satisfies RunCliResult;
};

export const listProfiles = async (runtime: CliRuntimeInput) => {
  const repository = await createRepository(runtime);
  const profiles = await repository.list();

  return {
    exitCode: 0,
    stdout: okEnvelope<ProfileRecord[]>("profile", "list", profiles),
  } satisfies RunCliResult;
};

export const updateProfile = async (
  runtime: CliRuntimeInput,
  input: {
    id: string;
    displayName?: string;
    locale?: string;
    timezone?: string;
    summary?: string;
    metadata?: string;
  },
) => {
  const repository = await createRepository(runtime);
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
    return {
      exitCode: 4,
      stdout: errorEnvelope(
        "profile",
        "update",
        "NOT_FOUND",
        `Profile ${input.id} not found`,
      ),
    } satisfies RunCliResult;
  }

  return {
    exitCode: 0,
    stdout: okEnvelope<ProfileRecord>("profile", "update", profile),
  } satisfies RunCliResult;
};

export const deleteProfile = async (
  runtime: CliRuntimeInput,
  id: string,
) => {
  const repository = await createRepository(runtime);
  const deleted = await repository.delete(id);

  if (!deleted) {
    return {
      exitCode: 4,
      stdout: errorEnvelope(
        "profile",
        "delete",
        "NOT_FOUND",
        `Profile ${id} not found`,
      ),
    } satisfies RunCliResult;
  }

  return {
    exitCode: 0,
    stdout: okEnvelope("profile", "delete", {
      id,
      deleted: true,
    }),
  } satisfies RunCliResult;
};
