import { Command } from "commander";

import type { CliRuntimeInput, ResultRef } from "../../runtime.js";
import { registerCommand } from "../../registry.js";
import { notImplemented } from "../not_implemented.js";

export const registerFeedbackCommands = (
  program: Command,
  _runtime: CliRuntimeInput,
  resultRef: ResultRef,
): void => {
  const feedback = new Command("feedback").description("User feedback: record and query feedback events");

  feedback
    .command("log")
    .description("Record a feedback event")
    .requiredOption("--kind <kind>", "event kind: card_open | card_click | explicit_rating | dismiss")
    .option("--item-id <itemId>", "related item ID")
    .option("--value <value>", "feedback value")
    .option("--at <timestamp>", "event timestamp (ISO 8601)")
    .option("--dry-run", "preview without saving")
    .option("--json")
    .action(() => {
      resultRef.current = notImplemented("feedback", "log");
    });

  feedback
    .command("list")
    .description("List feedback events")
    .option("--since <duration>", "time window (e.g. 7d, 24h)")
    .option("--kind <kind>", "filter by event kind")
    .option("--limit <n>", "max results", "50")
    .option("--json")
    .action(() => {
      resultRef.current = notImplemented("feedback", "list");
    });

  feedback
    .command("get")
    .description("Get a single feedback event")
    .requiredOption("--id <id>", "feedback event ID")
    .option("--json")
    .action(() => {
      resultRef.current = notImplemented("feedback", "get");
    });

  program.addCommand(feedback);

  registerCommand({
    domain: "feedback",
    command: "log",
    description: "Record a feedback event (card_open, card_click, explicit_rating, dismiss)",
    risk: "write",
    supportsDryRun: true,
    flags: [
      { name: "kind", type: "string", required: true, enum: ["card_open", "card_click", "explicit_rating", "dismiss"], description: "Event kind" },
      { name: "item-id", type: "string", required: false, description: "Related item ID" },
      { name: "value", type: "string", required: false, description: "Feedback value (e.g. thumbs_up)" },
      { name: "at", type: "string", required: false, description: "Event timestamp (ISO 8601)" },
    ],
  });

  registerCommand({
    domain: "feedback",
    command: "list",
    description: "List feedback events within a time window",
    risk: "read",
    supportsDryRun: false,
    flags: [
      { name: "since", type: "string", required: false, description: "Time window (e.g. 7d, 24h)" },
      { name: "kind", type: "string", required: false, description: "Filter by event kind" },
      { name: "limit", type: "number", required: false, default: "50", description: "Max results" },
    ],
  });

  registerCommand({
    domain: "feedback",
    command: "get",
    description: "Get a single feedback event by ID",
    risk: "read",
    supportsDryRun: false,
    flags: [
      { name: "id", type: "string", required: true, description: "Feedback event ID" },
    ],
  });
};
