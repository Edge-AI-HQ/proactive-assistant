import { callCore } from "../../output/adapter.js";
import { world as coreWorld, CoreError } from "../../../core/index.js";
import { okEnvelope, errorEnvelope } from "../../output/envelope.js";
import { exitCodeForType, type ErrorTypeValue } from "../../output/errors.js";
import type { CliRuntimeInput, RunCliResult } from "../../runtime.js";
import type { WorldEmbeddingProvider } from "../../../core/domains/world/embedding.js";
import type { WorldSemanticIndex } from "../../../core/domains/world/semantic_index.js";

export const searchNews = async (
  runtime: CliRuntimeInput,
  input: { query: string; limit?: string; provider?: string; full?: boolean },
): Promise<RunCliResult> =>
  callCore("world", "search", () => coreWorld.searchNews(runtime, input));

export const fetchHeadlines = async (
  runtime: CliRuntimeInput,
  input: { topic?: string; region?: string; limit?: string; provider?: string; full?: boolean },
): Promise<RunCliResult> =>
  callCore("world", "headlines", () => coreWorld.fetchHeadlines(runtime, input));

export const runWorldIndexRefresh = async (
  runtime: CliRuntimeInput,
  input: { all?: boolean; limit?: string | number },
  deps?: {
    embeddingProvider?: WorldEmbeddingProvider;
    semanticIndex?: WorldSemanticIndex;
  },
): Promise<RunCliResult> =>
  callCore("world", "index refresh", () =>
    coreWorld.runWorldIndexRefresh(runtime, input, deps),
  );

export const searchWorldItems = async (
  runtime: CliRuntimeInput,
  input: {
    query: string;
    strategy?: string;
    since?: string;
    until?: string;
    limit?: string | number;
  },
  deps?: {
    embeddingProvider?: WorldEmbeddingProvider;
    semanticIndex?: WorldSemanticIndex;
  },
): Promise<RunCliResult> => {
  try {
    const result = await coreWorld.searchWorldItems(runtime, input, deps);
    const notice = result.notice
      ? { search: result.notice }
      : undefined;
    return {
      exitCode: 0,
      stdout: okEnvelope("world", "find", result, notice),
    };
  } catch (error) {
    if (error instanceof CoreError) {
      return {
        exitCode: exitCodeForType(error.type as ErrorTypeValue),
        stdout: errorEnvelope(
          "world",
          "find",
          error.type,
          error.code,
          error.message,
          error.hint,
        ),
      };
    }
    throw error;
  }
};

export const listWorldItems = async (
  runtime: CliRuntimeInput,
  input: {
    limit?: string;
    query?: string;
    since?: string;
    until?: string;
    afterId?: string;
    afterUpdatedAt?: string;
    full?: boolean;
  },
): Promise<RunCliResult> =>
  callCore("world", "list", () => coreWorld.listWorldItems(runtime, input));

export const getWorldItem = async (
  runtime: CliRuntimeInput,
  id: string,
  full = false,
): Promise<RunCliResult> =>
  callCore("world", "get", () => coreWorld.getWorldItem(runtime, id, full));

export const shortlistWorldItems = async (
  runtime: CliRuntimeInput,
  input: {
    profileId: string;
    limit?: string;
  },
): Promise<RunCliResult> =>
  callCore("world", "shortlist", () =>
    coreWorld.shortlistWorldItems(runtime, input),
  );

export const buildWorldContext = async (
  runtime: CliRuntimeInput,
  input: {
    ids: string;
    full?: boolean;
  },
): Promise<RunCliResult> =>
  callCore("world", "context", () =>
    coreWorld.buildWorldContext(runtime, input),
  );
