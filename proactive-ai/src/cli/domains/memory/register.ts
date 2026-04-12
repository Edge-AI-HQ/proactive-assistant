import { Command } from "commander";

import { registerCommand } from "../../registry.js";
import type { CliRuntimeInput, ResultRef } from "../../runtime.js";
import {
  buildMemoryContext,
  listMemoryEntries,
  searchMemoryEvents,
} from "./service.js";

export const registerMemoryCommands = (
  program: Command,
  runtime: CliRuntimeInput,
  resultRef: ResultRef,
): void => {
  const memory = new Command("memory").description(
    "Inspect the independent memory domain used by proactive recommendation flows",
  );

  const entries = new Command("entries").description("Read consolidated memory entries");
  entries
    .command("list")
    .description("List memory entries for a profile")
    .option("--profile-id <profileId>", "profile id", "default")
    .option("--limit <limit>", "max entries to return")
    .option("--status <status>", "filter by status")
    .option("--category <category>", "filter by category")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await listMemoryEntries(runtime, options);
    });

  const events = new Command("events").description("Search raw memory evidence events");
  events
    .command("search")
    .description("Search memory events for a profile")
    .requiredOption("--query <query>", "search query")
    .option("--profile-id <profileId>", "profile id", "default")
    .option("--limit <limit>", "max events to return")
    .option("--subject-type <subjectType>", "filter by subject type")
    .option("--subject-key <subjectKey>", "filter by subject key")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await searchMemoryEvents(runtime, options);
    });

  memory
    .command("context")
    .description("Build a memory context pack for prompt injection or debugging")
    .option("--profile-id <profileId>", "profile id", "default")
    .option("--query <query>", "case-specific query text")
    .option("--resident-limit <residentLimit>", "max resident memories")
    .option("--relevant-limit <relevantLimit>", "max relevant memories")
    .option("--recent-event-limit <recentEventLimit>", "max recent events")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await buildMemoryContext(runtime, options);
    });

  memory.addCommand(entries);
  memory.addCommand(events);
  program.addCommand(memory);

  registerCommand({
    domain: "memory",
    command: "entries list",
    description: "List consolidated memory entries for a profile",
    risk: "read",
    supportsDryRun: false,
    flags: [
      { name: "profile-id", type: "string", required: false, default: "default", description: "Profile id" },
      { name: "limit", type: "number", required: false, description: "Maximum number of entries" },
      { name: "status", type: "string", required: false, description: "Filter by entry status" },
      { name: "category", type: "string", required: false, description: "Filter by entry category" },
    ],
  });

  registerCommand({
    domain: "memory",
    command: "events search",
    description: "Search raw memory events for a profile",
    risk: "read",
    supportsDryRun: false,
    flags: [
      { name: "query", type: "string", required: true, description: "Search query" },
      { name: "profile-id", type: "string", required: false, default: "default", description: "Profile id" },
      { name: "limit", type: "number", required: false, description: "Maximum number of events" },
      { name: "subject-type", type: "string", required: false, description: "Filter by subject type" },
      { name: "subject-key", type: "string", required: false, description: "Filter by subject key" },
    ],
  });

  registerCommand({
    domain: "memory",
    command: "context",
    description: "Build a resident + relevant memory context pack",
    risk: "read",
    supportsDryRun: false,
    flags: [
      { name: "profile-id", type: "string", required: false, default: "default", description: "Profile id" },
      { name: "query", type: "string", required: false, description: "Case-specific recall query" },
      { name: "resident-limit", type: "number", required: false, description: "Maximum resident memories" },
      { name: "relevant-limit", type: "number", required: false, description: "Maximum relevant memories" },
      { name: "recent-event-limit", type: "number", required: false, description: "Maximum recent events" },
    ],
  });
};
