import { PinDatabaseManager } from "../../db/database.js";
import { resolveAppRootFromCtx } from "../../../core/paths.js";
import { errorEnvelope, okEnvelope } from "../../output/envelope.js";
import { ErrorType } from "../../output/errors.js";
import type { CliRuntimeInput, RunCliResult } from "../../runtime.js";
import { LoopRepository } from "./repository.js";

const createRepository = async (runtime: CliRuntimeInput): Promise<LoopRepository> => {
  const dataRoot = resolveAppRootFromCtx(runtime);
  const manager = new PinDatabaseManager(dataRoot);
  await manager.init();
  return new LoopRepository(manager.open("pin"));
};

export const commitLoopRun = async (
  runtime: CliRuntimeInput,
  input: { runToken: string },
): Promise<RunCliResult> => {
  const repository = await createRepository(runtime);

  try {
    const committedAt = new Date().toISOString();
    const result = await repository.commitContextRun(input.runToken, committedAt);
    return {
      exitCode: 0,
      stdout: okEnvelope("loop", "commit", {
        runToken: input.runToken,
        processedCount: result.processedCount,
        committedAt,
      }),
    };
  } catch (error) {
    const code = error instanceof Error ? error.message : "INTERNAL";
    if (code === "RUN_TOKEN_NOT_FOUND") {
      return {
        exitCode: 1,
        stdout: errorEnvelope(
          "loop",
          "commit",
          ErrorType.NOT_FOUND,
          "RUN_TOKEN_NOT_FOUND",
          `Run token ${input.runToken} was not found`,
          "run `pin context incremental --json` to obtain a fresh run token",
        ),
      };
    }
    if (code === "RUN_TOKEN_NOT_OPEN") {
      return {
        exitCode: 1,
        stdout: errorEnvelope(
          "loop",
          "commit",
          ErrorType.CONFLICT,
          "RUN_TOKEN_ALREADY_COMMITTED",
          `Run token ${input.runToken} is no longer open`,
          "use a fresh run token from `pin context incremental --json`",
        ),
      };
    }
    throw error;
  }
};

export const getLoopStatus = async (
  runtime: CliRuntimeInput,
): Promise<RunCliResult> => {
  const repository = await createRepository(runtime);
  const status = await repository.getLoopStatus();
  return {
    exitCode: 0,
    stdout: okEnvelope("loop", "status", status),
  };
};
