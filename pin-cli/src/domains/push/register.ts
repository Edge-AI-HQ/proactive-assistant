import { Command } from "commander";

import type { CliRuntimeInput, ResultRef } from "../../runtime.js";
import { registerCommand } from "../../registry.js";
import { notImplemented } from "../not_implemented.js";

export const registerPushCommands = (
  program: Command,
  _runtime: CliRuntimeInput,
  resultRef: ResultRef,
): void => {
  const push = new Command("push").description("Push records: track what was pushed, when, and outcomes");

  push
    .command("record")
    .description("Record a new push")
    .requiredOption("--kind <kind>", "push kind: proactive_card | notification | digest")
    .requiredOption("--title <title>", "push title")
    .option("--ref <ref>", "reference to related content")
    .option("--reason <reason>", "why this push was generated")
    .option("--dry-run", "preview without saving")
    .option("--json")
    .action(() => {
      resultRef.current = notImplemented("push", "record");
    });

  push
    .command("history")
    .description("List push history")
    .option("--limit <n>", "max results", "50")
    .option("--kind <kind>", "filter by push kind")
    .option("--json")
    .action(() => {
      resultRef.current = notImplemented("push", "history");
    });

  push
    .command("get")
    .description("Get a single push record")
    .requiredOption("--id <id>", "push record ID")
    .option("--json")
    .action(() => {
      resultRef.current = notImplemented("push", "get");
    });

  push
    .command("outcome")
    .description("Record push delivery outcome")
    .requiredOption("--id <id>", "push record ID")
    .requiredOption("--status <status>", "outcome: clicked | dismissed | ignored | converted")
    .option("--dry-run", "preview without saving")
    .option("--json")
    .action(() => {
      resultRef.current = notImplemented("push", "outcome");
    });

  push
    .command("find-similar")
    .description("Find similar past pushes (for dedup)")
    .requiredOption("--kind <kind>", "push kind")
    .option("--ref <ref>", "content reference")
    .option("--since <duration>", "lookback window (e.g. 14d)")
    .option("--json")
    .action(() => {
      resultRef.current = notImplemented("push", "find-similar");
    });

  program.addCommand(push);

  registerCommand({
    domain: "push",
    command: "record",
    description: "Record a new push event",
    risk: "write",
    supportsDryRun: true,
    flags: [
      { name: "kind", type: "string", required: true, enum: ["proactive_card", "notification", "digest"], description: "Push kind" },
      { name: "title", type: "string", required: true, description: "Push title" },
      { name: "ref", type: "string", required: false, description: "Reference to related content" },
      { name: "reason", type: "string", required: false, description: "Why this push was generated" },
    ],
  });

  registerCommand({
    domain: "push",
    command: "history",
    description: "List push history",
    risk: "read",
    supportsDryRun: false,
    flags: [
      { name: "limit", type: "number", required: false, default: "50", description: "Max results" },
      { name: "kind", type: "string", required: false, description: "Filter by push kind" },
    ],
  });

  registerCommand({
    domain: "push",
    command: "get",
    description: "Get a single push record by ID",
    risk: "read",
    supportsDryRun: false,
    flags: [
      { name: "id", type: "string", required: true, description: "Push record ID" },
    ],
  });

  registerCommand({
    domain: "push",
    command: "outcome",
    description: "Record the delivery outcome of a push",
    risk: "write",
    supportsDryRun: true,
    flags: [
      { name: "id", type: "string", required: true, description: "Push record ID" },
      { name: "status", type: "string", required: true, enum: ["clicked", "dismissed", "ignored", "converted"], description: "Outcome status" },
    ],
  });

  registerCommand({
    domain: "push",
    command: "find-similar",
    description: "Find similar past pushes for deduplication",
    risk: "read",
    supportsDryRun: false,
    flags: [
      { name: "kind", type: "string", required: true, description: "Push kind" },
      { name: "ref", type: "string", required: false, description: "Content reference" },
      { name: "since", type: "string", required: false, description: "Lookback window (e.g. 14d)" },
    ],
  });
};
