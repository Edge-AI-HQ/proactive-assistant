import { PinDatabaseManager } from "../../db/database.js";
import { resolveAppRootFromCtx } from "../../../core/paths.js";
import { okEnvelope } from "../../output/envelope.js";
import type { CliRuntimeInput, RunCliResult } from "../../runtime.js";
import { LoopRepository } from "../loop/repository.js";

function toSimpleWorldItem(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    id: payload["id"] ?? null,
    title: payload["title"] ?? null,
    summary: payload["summary"] ?? null,
    provider: payload["provider"] ?? null,
    publishedAt: payload["publishedAt"] ?? null,
    updatedAt: payload["updatedAt"] ?? null,
  };
}

function toSimplePersonalItem(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    count: payload["count"] ?? null,
    snapshotHash: payload["snapshotHash"] ?? null,
    connections: payload["connections"] ?? [],
  };
}

export const getIncrementalContext = async (
  runtime: CliRuntimeInput,
  input: { limit?: string; minAgeMs?: string },
): Promise<RunCliResult> => {
  const dataRoot = resolveAppRootFromCtx(runtime);
  const manager = new PinDatabaseManager(dataRoot);
  await manager.init();
  const repository = new LoopRepository(manager.open("pin"));
  const limit = Math.max(1, Number.parseInt(input.limit ?? "50", 10) || 50);
  const minAgeMs = Math.max(0, Number.parseInt(input.minAgeMs ?? "0", 10) || 0);
  const context = await repository.createIncrementalContextRun({
    limit,
    minAgeMs,
  });

  if (!context) {
    return {
      exitCode: 0,
      stdout: okEnvelope("context", "incremental", {
        runToken: null,
        generatedAt: new Date().toISOString(),
        items: { world: [], personal: [] },
        meta: {
          pendingCount: 0,
          oldestPendingAt: null,
        },
      }),
    };
  }

  return {
    exitCode: 0,
    stdout: okEnvelope("context", "incremental", {
      runToken: context.runToken,
      generatedAt: context.generatedAt,
      items: {
        world: context.items
          .filter((item) => item.source === "world")
          .map((item) => toSimpleWorldItem(item.payload)),
        personal: context.items
          .filter((item) => item.source === "personal")
          .map((item) => toSimplePersonalItem(item.payload)),
      },
      meta: {
        pendingCount: context.pendingCount,
        oldestPendingAt: context.oldestPendingAt,
      },
    }),
  };
};
