import { Command } from "commander";

import { registerCommand } from "../../registry.js";
import type { CliRuntimeInput, ResultRef } from "../../runtime.js";
import {
  buildWorldContext,
  fetchHeadlines,
  getWorldItem,
  listWorldItems,
  runWorldIndexRefresh,
  searchNews,
  searchWorldItems,
  shortlistWorldItems,
} from "./service.js";

export const registerWorldCommands = (
  program: Command,
  runtime: CliRuntimeInput,
  resultRef: ResultRef,
): void => {
  const world = new Command("world");

  world
    .command("search")
    .requiredOption("--query <query>")
    .option("--provider <provider>", "google-news | sec | fed")
    .option("--limit <limit>")
    .option("--full")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await searchNews(runtime, options);
    });

  world
    .command("headlines")
    .option("--topic <topic>")
    .option("--region <region>")
    .option("--provider <provider>", "google-news | sec | fed")
    .option("--limit <limit>")
    .option("--full")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await fetchHeadlines(runtime, options);
    });

  const index = world.command("index").description("Manage world semantic indices");
  index
    .command("refresh")
    .option("--all")
    .option("--limit <limit>", "max items to process", "100")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await runWorldIndexRefresh(runtime, options);
    });

  world
    .command("find")
    .requiredOption("--query <query>")
    .option("--strategy <strategy>", "keyword | semantic | hybrid")
    .option("--since <since>")
    .option("--until <until>")
    .option("--limit <limit>")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await searchWorldItems(runtime, options);
    });

  world
    .command("shortlist")
    .requiredOption("--profile-id <profileId>")
    .option("--limit <limit>")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await shortlistWorldItems(runtime, options);
    });

  world
    .command("context")
    .requiredOption("--ids <ids>")
    .option("--full")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await buildWorldContext(runtime, options);
    });

  world
    .command("list")
    .option("--query <query>")
    .option("--limit <limit>")
    .option("--since <since>")
    .option("--until <until>")
    .option("--after-id <afterId>")
    .option("--after-updated-at <afterUpdatedAt>")
    .option("--full")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await listWorldItems(runtime, options);
    });

  world
    .command("get")
    .requiredOption("--id <id>")
    .option("--full")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await getWorldItem(runtime, options.id, options.full === true);
    });

  program.addCommand(world);

  registerCommand({
    domain: "world",
    command: "search",
    description: "Search external news by keyword and store deduplicated results locally",
    risk: "write",
    supportsDryRun: false,
    flags: [
      { name: "query", type: "string", required: true, description: "Search query" },
      { name: "provider", type: "string", required: false, description: "News provider: google-news | sec | fed" },
      { name: "limit", type: "number", required: false, description: "Maximum result count" },
      { name: "full", type: "boolean", required: false, description: "Return the full stored record" },
    ],
  });

  registerCommand({
    domain: "world",
    command: "headlines",
    description: "Fetch global or topical headlines and store them locally",
    risk: "write",
    supportsDryRun: false,
    flags: [
      { name: "topic", type: "string", required: false, description: "Headline topic, e.g. finance or geopolitics" },
      { name: "region", type: "string", required: false, description: "Headline region, e.g. global" },
      { name: "provider", type: "string", required: false, description: "Headline provider: google-news | sec | fed" },
      { name: "limit", type: "number", required: false, description: "Maximum result count" },
      { name: "full", type: "boolean", required: false, description: "Return the full stored record" },
    ],
  });

  registerCommand({
    domain: "world",
    command: "index refresh",
    description: "Refresh the semantic index for stored world items",
    risk: "write",
    supportsDryRun: true,
    flags: [
      { name: "all", type: "boolean", required: false, description: "Rebuild the full world semantic index" },
      { name: "limit", type: "number", required: false, description: "Maximum items to process" },
    ],
  });

  registerCommand({
    domain: "world",
    command: "find",
    description: "Search stored world items with keyword, semantic, or hybrid retrieval",
    risk: "read",
    supportsDryRun: false,
    flags: [
      { name: "query", type: "string", required: true, description: "Search query" },
      { name: "strategy", type: "string", required: false, enum: ["keyword", "semantic", "hybrid"], description: "Search strategy" },
      { name: "since", type: "string", required: false, description: "Start timestamp (ISO-8601)" },
      { name: "until", type: "string", required: false, description: "End timestamp (ISO-8601)" },
      { name: "limit", type: "number", required: false, description: "Maximum result count" },
    ],
  });

  registerCommand({
    domain: "world",
    command: "shortlist",
    description: "Build a deterministic world candidate shortlist for a profile",
    risk: "read",
    supportsDryRun: false,
    flags: [
      { name: "profile-id", type: "string", required: true, description: "Profile ID" },
      { name: "limit", type: "number", required: false, description: "Maximum result count" },
    ],
  });

  registerCommand({
    domain: "world",
    command: "context",
    description: "Build compact world context records for selected item IDs",
    risk: "read",
    supportsDryRun: false,
    flags: [
      { name: "ids", type: "string", required: true, description: "Comma-separated world item IDs" },
      { name: "full", type: "boolean", required: false, description: "Return the full stored record" },
    ],
  });

  registerCommand({
    domain: "world",
    command: "list",
    description: "List stored world items with time and cursor filters",
    risk: "read",
    supportsDryRun: false,
    flags: [
      { name: "query", type: "string", required: false, description: "Keyword filter" },
      { name: "limit", type: "number", required: false, description: "Maximum result count" },
      { name: "since", type: "string", required: false, description: "Start timestamp (ISO-8601)" },
      { name: "until", type: "string", required: false, description: "End timestamp (ISO-8601)" },
      { name: "after-id", type: "string", required: false, description: "Cursor ID from the current sort order" },
      { name: "after-updated-at", type: "string", required: false, description: "Incremental cursor on updatedAt" },
      { name: "full", type: "boolean", required: false, description: "Return the full stored record" },
    ],
  });

  registerCommand({
    domain: "world",
    command: "get",
    description: "Get a single stored world item by ID",
    risk: "read",
    supportsDryRun: false,
    flags: [
      { name: "id", type: "string", required: true, description: "World item ID" },
      { name: "full", type: "boolean", required: false, description: "Return the full stored record" },
    ],
  });
};
