import { Command } from "commander";

import type { CliRuntimeInput, ResultRef } from "../../runtime.js";
import { registerCommand } from "../../registry.js";
import {
  recordPush,
  listPushHistory,
  getPush,
  recordOutcome,
  findSimilarPushes,
} from "./service.js";

export const registerPushCommands = (
  program: Command,
  runtime: CliRuntimeInput,
  resultRef: ResultRef,
): void => {
  const push = new Command("push").description("Push records: track what was pushed, when, and outcomes");

  push
    .command("record")
    .description("Record a new push")
    .requiredOption("--kind <kind>", "push kind: proactive_card | notification | digest")
    .requiredOption("--title <title>", "push title")
    .option("--intent-card-id <intentCardId>", "related intent card ID")
    .option("--basket <basket>", "goal basket: work | health | family | wealth | growth | life")
    .option("--channel <channel>", "channel: telegram | web | mobile | im")
    .option("--ref <ref>", "reference to related content")
    .option("--reason <reason>", "why this push was generated")
    .option("--dry-run", "preview without saving")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await recordPush(runtime, options);
    });

  push
    .command("history")
    .description("List push history")
    .option("--limit <n>", "max results", "50")
    .option("--kind <kind>", "filter by push kind")
    .option("--basket <basket>", "filter by goal basket")
    .option("--channel <channel>", "filter by channel")
    .option("--since <duration>", "time window (e.g. 7d, 24h, 2w)")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await listPushHistory(runtime, options);
    });

  push
    .command("get")
    .description("Get a single push record")
    .requiredOption("--id <id>", "push record ID")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await getPush(runtime, options);
    });

  push
    .command("outcome")
    .description("Record push delivery outcome")
    .requiredOption("--id <id>", "push record ID")
    .requiredOption("--status <status>", "outcome: clicked | dismissed | ignored | converted")
    .option("--dry-run", "preview without saving")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await recordOutcome(runtime, options);
    });

  push
    .command("find-similar")
    .description("Find similar past pushes (for dedup)")
    .requiredOption("--kind <kind>", "push kind")
    .option("--ref <ref>", "content reference")
    .option("--title <title>", "title keyword for similarity matching")
    .option("--since <duration>", "lookback window (e.g. 14d)")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await findSimilarPushes(runtime, options);
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
      { name: "intent-card-id", type: "string", required: false, description: "Related intent card ID" },
      { name: "basket", type: "string", required: false, enum: ["work", "health", "family", "wealth", "growth", "life"], description: "Goal basket" },
      { name: "channel", type: "string", required: false, enum: ["telegram", "web", "mobile", "im"], description: "Channel" },
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
      { name: "kind", type: "string", required: false, enum: ["proactive_card", "notification", "digest"], description: "Filter by push kind" },
      { name: "basket", type: "string", required: false, enum: ["work", "health", "family", "wealth", "growth", "life"], description: "Filter by goal basket" },
      { name: "channel", type: "string", required: false, enum: ["telegram", "web", "mobile", "im"], description: "Filter by channel" },
      { name: "since", type: "string", required: false, description: "Time window (e.g. 7d, 24h, 2w)" },
    ],
  });

  registerCommand({
    domain: "push",
    command: "get",
    description: "Get a single push record by ID (includes outcomes)",
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
      { name: "kind", type: "string", required: true, enum: ["proactive_card", "notification", "digest"], description: "Push kind" },
      { name: "ref", type: "string", required: false, description: "Content reference" },
      { name: "title", type: "string", required: false, description: "Title keyword for similarity matching" },
      { name: "since", type: "string", required: false, description: "Lookback window (e.g. 14d)" },
    ],
  });
};
