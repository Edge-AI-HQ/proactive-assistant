import { callCore } from "../../output/adapter.js";
import { memory as coreMemory } from "../../../core/index.js";
import type { CliRuntimeInput, RunCliResult } from "../../runtime.js";

const DEFAULT_PROFILE_ID = "default";

export const listMemoryEntries = async (
  runtime: CliRuntimeInput,
  input: {
    profileId?: string;
    limit?: string;
    status?: string;
    category?: string;
  },
): Promise<RunCliResult> =>
  callCore("memory", "entries list", () =>
    coreMemory.listMemoryEntries(runtime, {
      profileId: input.profileId ?? DEFAULT_PROFILE_ID,
      limit: input.limit ? Number.parseInt(input.limit, 10) : undefined,
      status: input.status,
      category: input.category,
    }),
  );

export const searchMemoryEvents = async (
  runtime: CliRuntimeInput,
  input: {
    profileId?: string;
    query: string;
    limit?: string;
    subjectType?: string;
    subjectKey?: string;
  },
): Promise<RunCliResult> =>
  callCore("memory", "events search", () =>
    coreMemory.searchMemoryEvents(runtime, {
      profileId: input.profileId ?? DEFAULT_PROFILE_ID,
      query: input.query,
      limit: input.limit ? Number.parseInt(input.limit, 10) : undefined,
      subjectType: input.subjectType,
      subjectKey: input.subjectKey,
    }),
  );

export const buildMemoryContext = async (
  runtime: CliRuntimeInput,
  input: {
    profileId?: string;
    query?: string;
    residentLimit?: string;
    relevantLimit?: string;
    recentEventLimit?: string;
  },
): Promise<RunCliResult> =>
  callCore("memory", "context", () =>
    coreMemory.buildMemoryContext(runtime, {
      profileId: input.profileId ?? DEFAULT_PROFILE_ID,
      queryText: input.query,
      residentLimit: input.residentLimit ? Number.parseInt(input.residentLimit, 10) : undefined,
      relevantLimit: input.relevantLimit ? Number.parseInt(input.relevantLimit, 10) : undefined,
      recentEventLimit: input.recentEventLimit ? Number.parseInt(input.recentEventLimit, 10) : undefined,
    }),
  );
