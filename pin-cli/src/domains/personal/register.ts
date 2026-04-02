import { Command } from "commander";

import { notImplemented } from "../not_implemented.js";
import { registerCommand } from "../../registry.js";
import type { CliRuntimeInput, ResultRef } from "../../runtime.js";
import {
  getPersonalItem,
  listPersonalSources,
  runPersonalIndexRefresh,
  listPersonalSyncStatus,
  runPersonalSync,
  searchPersonalItems,
  timelinePersonalItems,
} from "./service.js";

export const registerPersonalCommands = (
  program: Command,
  runtime: CliRuntimeInput,
  resultRef: ResultRef,
): void => {
  const personal = new Command("personal").description(
    "Personal feed: sync and search personal context from connected sources",
  );

  const source = personal.command("source").description("Manage connected personal sources");
  source
    .command("list")
    .description("List connected personal sources")
    .option("--json")
    .action(async () => {
      resultRef.current = await listPersonalSources(runtime);
    });

  const sync = personal.command("sync").description("Run and inspect personal feed syncs");
  sync
    .command("run")
    .description("Run a sync across all sources or a single source")
    .option("--all", "sync all sources")
    .option("--source <source>", "sync a single source")
    .option("--mode <mode>", "sync mode: incremental | backfill", "incremental")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await runPersonalSync(runtime, options);
    });

  sync
    .command("status")
    .description("Show latest sync state")
    .option("--source <source>", "filter by source ID")
    .option("--recent <recent>", "show the most recent runs")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await listPersonalSyncStatus(runtime, options);
    });

  const index = personal.command("index").description("Manage semantic search indices");
  index
    .command("refresh")
    .description("Refresh the semantic index for personal items")
    .option("--all", "rebuild the entire semantic index")
    .option("--pending", "refresh only items changed since the last semantic index update")
    .option("--limit <limit>", "max items to process", "100")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await runPersonalIndexRefresh(runtime, options);
    });

  const item = personal.command("item").description("Read personal feed items");
  item
    .command("get")
    .description("Get a personal feed item by ID")
    .requiredOption("--id <id>", "personal item ID")
    .option("--include-raw", "include raw payload")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await getPersonalItem(runtime, options.id, {
        includeRaw: options.includeRaw === true,
      });
    });

  personal
    .command("search")
    .description("Search personal feed items")
    .requiredOption("--query <query>", "search query")
    .option("--strategy <strategy>", "keyword | semantic | hybrid")
    .option("--from <from>", "start timestamp in ISO-8601")
    .option("--to <to>", "end timestamp in ISO-8601")
    .option("--source <source>", "comma-separated source IDs")
    .option("--toolkit <toolkit>", "comma-separated toolkit names")
    .option("--type <type>", "comma-separated item types")
    .option("--facet <facet>", "exact metadata filter, key=value")
    .option("--limit <limit>", "max results")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await searchPersonalItems(runtime, options);
    });

  personal
    .command("timeline")
    .description("List personal feed items in a time window")
    .requiredOption("--from <from>", "start timestamp in ISO-8601")
    .requiredOption("--to <to>", "end timestamp in ISO-8601")
    .option("--source <source>", "comma-separated source IDs")
    .option("--toolkit <toolkit>", "comma-separated toolkit names")
    .option("--type <type>", "comma-separated item types")
    .option("--limit <limit>", "max results")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await timelinePersonalItems(runtime, options);
    });

  program.addCommand(personal);

  registerCommand({
    domain: "personal",
    command: "source list",
    description: "List connected personal-feed sources discovered from provider integrations",
    risk: "read",
    supportsDryRun: false,
    flags: [],
  });

  registerCommand({
    domain: "personal",
    command: "sync run",
    description: "Run a personal-feed sync for all or one source",
    risk: "write",
    supportsDryRun: true,
    flags: [
      { name: "all", type: "boolean", required: false, description: "Sync all sources" },
      { name: "source", type: "string", required: false, description: "Source ID to sync" },
      { name: "mode", type: "string", required: false, enum: ["incremental", "backfill"], default: "incremental", description: "Sync mode" },
    ],
  });

  registerCommand({
    domain: "personal",
    command: "sync status",
    description: "Show the latest personal-feed sync state per source",
    risk: "read",
    supportsDryRun: false,
    flags: [
      { name: "source", type: "string", required: false, description: "Source ID filter" },
      { name: "recent", type: "number", required: false, description: "Number of recent runs to show" },
    ],
  });

  registerCommand({
    domain: "personal",
    command: "index refresh",
    description: "Refresh the semantic index for personal-feed items",
    risk: "write",
    supportsDryRun: true,
    flags: [
      { name: "all", type: "boolean", required: false, description: "Rebuild the full semantic index" },
      { name: "pending", type: "boolean", required: false, description: "Index only pending items" },
      { name: "limit", type: "number", required: false, description: "Maximum items to process" },
    ],
  });

  registerCommand({
    domain: "personal",
    command: "search",
    description: "Search personal-feed items with time and source filters",
    risk: "read",
    supportsDryRun: false,
    flags: [
      { name: "query", type: "string", required: true, description: "Search query" },
      { name: "strategy", type: "string", required: false, enum: ["keyword", "semantic", "hybrid"], description: "Search strategy" },
      { name: "from", type: "string", required: false, description: "Start timestamp (ISO-8601)" },
      { name: "to", type: "string", required: false, description: "End timestamp (ISO-8601)" },
      { name: "source", type: "string", required: false, description: "Comma-separated source IDs" },
      { name: "toolkit", type: "string", required: false, description: "Comma-separated toolkit names" },
      { name: "type", type: "string", required: false, description: "Comma-separated item types" },
      { name: "facet", type: "string", required: false, description: "Exact metadata filter key=value" },
      { name: "limit", type: "number", required: false, description: "Maximum result count" },
    ],
  });

  registerCommand({
    domain: "personal",
    command: "item get",
    description: "Get a single personal-feed item by ID",
    risk: "read",
    supportsDryRun: false,
    flags: [
      { name: "id", type: "string", required: true, description: "Personal item ID" },
      { name: "include-raw", type: "boolean", required: false, description: "Include raw provider payload" },
    ],
  });
};
