import { runCli } from "../../cli.js";
import type { CliRuntimeInput, RunCliResult } from "../../runtime.js";

interface PersonalE2ESourceRecord {
  id: string;
  userId: string;
  toolkit: string;
  status: string;
  syncEnabled: boolean;
  syncSupported?: boolean;
}

interface PersonalE2ETimelineRecord {
  id: string;
  toolkit: string;
  title: string | null;
  snippet?: string | null;
}

interface PersonalE2EItemRecord {
  id: string;
  title: string | null;
  contentText?: string | null;
}

interface PersonalE2ESearchRecord {
  id: string;
}

export interface PersonalFeedE2ESummary {
  toolkit: string;
  query: string;
  sourceCount: number;
  syncedSourceCount: number;
  fetchedCount: number;
  timelineCount: number;
  indexedCount: number;
  semanticResultCount: number;
  hybridResultCount: number;
  sampleItemId: string;
}

export interface RunPersonalFeedE2EOptions {
  toolkit?: string;
  lookbackDays?: number;
  timelineLimit?: number;
  searchLimit?: number;
  indexLimit?: number;
  runCommand?: (argv: string[]) => Promise<RunCliResult>;
}

const defaultRunCommand = (
  runtime: CliRuntimeInput,
): ((argv: string[]) => Promise<RunCliResult>) => (argv) => runCli(argv, runtime);

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asArray = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

const stringOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const ensureOk = <T>(result: RunCliResult, label: string): T => {
  if (result.exitCode !== 0 || result.stdout.ok !== true) {
    const message =
      result.stdout.error?.message ?? `${label} failed with exit code ${result.exitCode}`;
    throw new Error(`${label} failed: ${message}`);
  }

  return result.stdout.data as T;
};

const deriveSearchQuery = (
  item: PersonalE2EItemRecord,
  timelineItem: PersonalE2ETimelineRecord,
): string => {
  const title = stringOrNull(item.title) ?? stringOrNull(timelineItem.title);
  if (title) {
    return title;
  }

  const content = stringOrNull(item.contentText) ?? stringOrNull(timelineItem.snippet);
  if (content) {
    return content.slice(0, 80);
  }

  throw new Error("无法从样本数据生成搜索 query");
};

const ensureSearchHit = (
  results: PersonalE2ESearchRecord[],
  itemId: string,
  label: string,
) => {
  if (results.length === 0) {
    throw new Error(`${label} returned no results`);
  }

  if (!results.some((row) => row.id === itemId)) {
    throw new Error(`${label} did not return the sampled item ${itemId}`);
  }
};

const ensureSearchNonEmpty = (
  results: PersonalE2ESearchRecord[],
  label: string,
) => {
  if (results.length === 0) {
    throw new Error(`${label} returned no results`);
  }
};

export const runPersonalFeedE2E = async (
  runtime: CliRuntimeInput,
  options?: RunPersonalFeedE2EOptions,
): Promise<PersonalFeedE2ESummary> => {
  const runCommand = options?.runCommand ?? defaultRunCommand(runtime);
  const toolkit = options?.toolkit ?? "gmail";
  const lookbackDays = options?.lookbackDays ?? 180;
  const timelineLimit = options?.timelineLimit ?? 10;
  const searchLimit = options?.searchLimit ?? 5;
  const indexLimit = options?.indexLimit ?? 200;
  const now = new Date();
  const from = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
  const to = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();

  const syncData = ensureOk<{
    sourcesSynced: number;
    itemsFetched: number;
  }>(
    await runCommand(["personal", "sync", "run", "--all", "--json"]),
    "personal sync run",
  );

  const sources = ensureOk<PersonalE2ESourceRecord[]>(
    await runCommand(["personal", "source", "list", "--json"]),
    "personal source list",
  ).filter(
    (source) =>
      source.toolkit === toolkit &&
      source.status.toUpperCase() === "ACTIVE" &&
      source.syncEnabled === true &&
      source.syncSupported !== false,
  );

  if (sources.length === 0) {
    throw new Error(`没有发现可用的 ${toolkit} source`);
  }

  const timeline = ensureOk<PersonalE2ETimelineRecord[]>(
    await runCommand([
      "personal",
      "timeline",
      "--from",
      from,
      "--to",
      to,
      "--toolkit",
      toolkit,
      "--limit",
      String(timelineLimit),
      "--json",
    ]),
    "personal timeline",
  );

  if (timeline.length === 0) {
    throw new Error(`${toolkit} timeline returned no items`);
  }

  const sample = timeline[0]!;
  const item = ensureOk<PersonalE2EItemRecord>(
    await runCommand([
      "personal",
      "item",
      "get",
      "--id",
      sample.id,
      "--json",
    ]),
    "personal item get",
  );
  const query = deriveSearchQuery(item, sample);

  const indexData = ensureOk<{
    itemsIndexed: number;
  }>(
    await runCommand([
      "personal",
      "index",
      "refresh",
      "--all",
      "--limit",
      String(indexLimit),
      "--json",
    ]),
    "personal index refresh",
  );

  const semantic = ensureOk<{
    results: PersonalE2ESearchRecord[];
  }>(
    await runCommand([
      "personal",
      "search",
      "--query",
      query,
      "--strategy",
      "semantic",
      "--toolkit",
      toolkit,
      "--limit",
      String(searchLimit),
      "--json",
    ]),
    "personal semantic search",
  );
  ensureSearchNonEmpty(
    asArray<PersonalE2ESearchRecord>(semantic.results),
    "semantic search",
  );

  const hybrid = ensureOk<{
    results: PersonalE2ESearchRecord[];
  }>(
    await runCommand([
      "personal",
      "search",
      "--query",
      query,
      "--strategy",
      "hybrid",
      "--toolkit",
      toolkit,
      "--limit",
      String(searchLimit),
      "--json",
    ]),
    "personal hybrid search",
  );
  ensureSearchHit(asArray<PersonalE2ESearchRecord>(hybrid.results), sample.id, "hybrid search");

  return {
    toolkit,
    query,
    sourceCount: sources.length,
    syncedSourceCount:
      typeof syncData.sourcesSynced === "number" ? syncData.sourcesSynced : 0,
    fetchedCount:
      typeof syncData.itemsFetched === "number" ? syncData.itemsFetched : 0,
    timelineCount: timeline.length,
    indexedCount:
      typeof indexData.itemsIndexed === "number" ? indexData.itemsIndexed : 0,
    semanticResultCount: asArray(semantic.results).length,
    hybridResultCount: asArray(hybrid.results).length,
    sampleItemId: sample.id,
  };
};

export const buildPersonalFeedE2ERuntime = (
  env: Record<string, string | undefined> = process.env,
): CliRuntimeInput => ({
  env,
  homeDir: process.cwd(),
});
