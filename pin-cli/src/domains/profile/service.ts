import { ProfileRepository } from "./repository.js";
import type { ProfileRecord } from "./schema.js";

import { PinDatabaseManager } from "../../db/database.js";
import { errorEnvelope, okEnvelope } from "../../output/envelope.js";
import { ErrorType } from "../../output/errors.js";
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
        exitCode: 1,
        stdout: errorEnvelope(
          "profile",
          "create",
          ErrorType.CONFLICT,
          "CONFLICT",
          `Profile ${input.id} already exists`,
          "run `pin profile list` to see existing profiles",
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
      exitCode: 1,
      stdout: errorEnvelope("profile", "get", ErrorType.NOT_FOUND, "NOT_FOUND", `Profile ${id} not found`, "run `pin profile list` to see available profiles"),
    } satisfies RunCliResult;
  }

  return {
    exitCode: 0,
    stdout: okEnvelope<ProfileRecord>("profile", "get", profile),
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
      exitCode: 1,
      stdout: errorEnvelope(
        "profile",
        "update",
        ErrorType.NOT_FOUND,
        "NOT_FOUND",
        `Profile ${input.id} not found`,
        "run `pin profile list` to see available profiles",
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
      exitCode: 1,
      stdout: errorEnvelope(
        "profile",
        "delete",
        ErrorType.NOT_FOUND,
        "NOT_FOUND",
        `Profile ${id} not found`,
        "run `pin profile list` to see available profiles",
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
