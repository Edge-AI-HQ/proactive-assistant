import { PushRepository } from "./repository.js";
import {
  VALID_PUSH_KINDS,
  VALID_PUSH_CHANNELS,
  VALID_BASKETS,
  VALID_OUTCOME_STATUSES,
} from "./schema.js";

import { PinDatabaseManager } from "../../db/database.js";
import { okEnvelope, errorEnvelope } from "../../output/envelope.js";
import { dryRunEnvelope } from "../../output/dryrun.js";
import { ErrorType } from "../../output/errors.js";
import { rejectDangerousChars } from "../../output/sanitize.js";
import type { CliRuntimeInput, RunCliResult } from "../../runtime.js";

const createRepository = async (runtime: CliRuntimeInput) => {
  const dataRoot = runtime.env.PIN_DATA_ROOT || `${runtime.homeDir}/.pin`;
  const manager = new PinDatabaseManager({ dataRoot });
  await manager.init();
  return new PushRepository(manager.open("pin"));
};

const validateEnum = (
  paramName: string,
  value: string | undefined,
  allowed: readonly string[],
): void => {
  if (value !== undefined && !allowed.includes(value)) {
    throw new Error(
      `Invalid --${paramName}: ${value}. Allowed: ${allowed.join(", ")}`,
    );
  }
};

const parseSinceToISO = (since: string): string => {
  const match = since.match(/^(\d+)(h|d|w)$/);
  if (!match) {
    throw new Error(`Invalid --since format: ${since}. Use e.g. 7d, 24h, 2w`);
  }

  const amount = parseInt(match[1], 10);
  const unit = match[2];
  const now = Date.now();
  let ms = 0;

  if (unit === "h") ms = amount * 60 * 60 * 1000;
  else if (unit === "d") ms = amount * 24 * 60 * 60 * 1000;
  else if (unit === "w") ms = amount * 7 * 24 * 60 * 60 * 1000;

  return new Date(now - ms).toISOString();
};

export const recordPush = async (
  runtime: CliRuntimeInput,
  input: {
    kind: string;
    title: string;
    intentCardId?: string;
    basket?: string;
    channel?: string;
    ref?: string;
    reason?: string;
    dryRun?: boolean;
  },
): Promise<RunCliResult> => {
  try {
    validateEnum("kind", input.kind, VALID_PUSH_KINDS);
    if (input.basket) validateEnum("basket", input.basket, VALID_BASKETS);
    if (input.channel) validateEnum("channel", input.channel, VALID_PUSH_CHANNELS);
    rejectDangerousChars("title", input.title);
    if (input.reason) rejectDangerousChars("reason", input.reason);

    const data = {
      kind: input.kind,
      title: input.title,
      intentCardId: input.intentCardId,
      basket: input.basket,
      channel: input.channel,
      ref: input.ref,
      reason: input.reason,
    };

    if (input.dryRun) {
      return dryRunEnvelope("push", "record", "INSERT", "push_records", data as unknown as Record<string, unknown>);
    }

    const repository = await createRepository(runtime);
    const record = await repository.createRecord(data);

    return {
      exitCode: 0,
      stdout: okEnvelope("push", "record", record),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown push record error";
    return {
      exitCode: message.includes("Invalid") ? 2 : 1,
      stdout: errorEnvelope(
        "push", "record",
        message.includes("Invalid") ? ErrorType.VALIDATION : ErrorType.INTERNAL,
        message.includes("Invalid") ? "INVALID_ARGUMENT" : "INTERNAL",
        message,
        "check `pin push record --help` for valid options",
      ),
    };
  }
};

export const listPushHistory = async (
  runtime: CliRuntimeInput,
  input: {
    limit?: string;
    kind?: string;
    basket?: string;
    channel?: string;
    since?: string;
  },
): Promise<RunCliResult> => {
  try {
    if (input.kind) validateEnum("kind", input.kind, VALID_PUSH_KINDS);
    if (input.basket) validateEnum("basket", input.basket, VALID_BASKETS);
    if (input.channel) validateEnum("channel", input.channel, VALID_PUSH_CHANNELS);

    const repository = await createRepository(runtime);
    const limit = parseInt(input.limit ?? "50", 10);
    const records = await repository.listRecords({
      kind: input.kind,
      basket: input.basket,
      channel: input.channel,
      since: input.since ? parseSinceToISO(input.since) : undefined,
      limit: Number.isNaN(limit) ? 50 : limit,
    });

    return {
      exitCode: 0,
      stdout: okEnvelope("push", "history", records),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown push history error";
    return {
      exitCode: message.includes("Invalid") ? 2 : 1,
      stdout: errorEnvelope(
        "push", "history",
        message.includes("Invalid") ? ErrorType.VALIDATION : ErrorType.INTERNAL,
        message.includes("Invalid") ? "INVALID_ARGUMENT" : "INTERNAL",
        message,
      ),
    };
  }
};

export const getPush = async (
  runtime: CliRuntimeInput,
  input: { id: string },
): Promise<RunCliResult> => {
  try {
    const repository = await createRepository(runtime);
    const record = await repository.getRecordWithOutcomes(input.id);

    if (!record) {
      return {
        exitCode: 1,
        stdout: errorEnvelope(
          "push", "get",
          ErrorType.NOT_FOUND, "NOT_FOUND",
          `Push record ${input.id} not found`,
          "run `pin push history` to see recent pushes",
        ),
      };
    }

    return {
      exitCode: 0,
      stdout: okEnvelope("push", "get", record),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown push get error";
    return {
      exitCode: 1,
      stdout: errorEnvelope(
        "push", "get",
        ErrorType.INTERNAL, "INTERNAL",
        message,
      ),
    };
  }
};

export const recordOutcome = async (
  runtime: CliRuntimeInput,
  input: {
    id: string;
    status: string;
    dryRun?: boolean;
  },
): Promise<RunCliResult> => {
  try {
    validateEnum("status", input.status, VALID_OUTCOME_STATUSES);

    if (input.dryRun) {
      return dryRunEnvelope("push", "outcome", "INSERT", "push_outcomes", {
        pushId: input.id,
        status: input.status,
      });
    }

    const repository = await createRepository(runtime);

    const pushRecord = await repository.getRecordById(input.id);
    if (!pushRecord) {
      return {
        exitCode: 1,
        stdout: errorEnvelope(
          "push", "outcome",
          ErrorType.NOT_FOUND, "NOT_FOUND",
          `Push record ${input.id} not found`,
          "run `pin push history` to see recent pushes",
        ),
      };
    }

    const outcome = await repository.createOutcome({
      pushId: input.id,
      status: input.status,
    });

    return {
      exitCode: 0,
      stdout: okEnvelope("push", "outcome", outcome),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown push outcome error";
    return {
      exitCode: message.includes("Invalid") ? 2 : 1,
      stdout: errorEnvelope(
        "push", "outcome",
        message.includes("Invalid") ? ErrorType.VALIDATION : ErrorType.INTERNAL,
        message.includes("Invalid") ? "INVALID_ARGUMENT" : "INTERNAL",
        message,
        "check `pin push outcome --help` for valid options",
      ),
    };
  }
};

export const findSimilarPushes = async (
  runtime: CliRuntimeInput,
  input: {
    kind: string;
    ref?: string;
    title?: string;
    since?: string;
  },
): Promise<RunCliResult> => {
  try {
    validateEnum("kind", input.kind, VALID_PUSH_KINDS);

    const repository = await createRepository(runtime);
    const records = await repository.findSimilar({
      kind: input.kind,
      ref: input.ref,
      title: input.title,
      since: input.since ? parseSinceToISO(input.since) : undefined,
      limit: 20,
    });

    return {
      exitCode: 0,
      stdout: okEnvelope("push", "find-similar", records),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown push find-similar error";
    return {
      exitCode: message.includes("Invalid") ? 2 : 1,
      stdout: errorEnvelope(
        "push", "find-similar",
        message.includes("Invalid") ? ErrorType.VALIDATION : ErrorType.INTERNAL,
        message.includes("Invalid") ? "INVALID_ARGUMENT" : "INTERNAL",
        message,
      ),
    };
  }
};
