import { Command } from "commander";

import type { CliRuntimeInput, ResultRef } from "../../runtime.js";
import { registerCommand } from "../../registry.js";
import { listRecentGeneratedCards } from "./service.js";

export const registerCardsCommands = (
  program: Command,
  runtime: CliRuntimeInput,
  resultRef: ResultRef,
): void => {
  const cards = new Command("cards").description(
    "Generated intent card history: inspect recently produced cards",
  );

  cards
    .command("recent")
    .description("List recently generated intent cards")
    .option("--limit <n>", "max results", "10")
    .option("--basket <basket>", "filter by goal basket")
    .option("--since <duration>", "time window (e.g. 7d, 24h, 2w)")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await listRecentGeneratedCards(runtime, options);
    });

  program.addCommand(cards);

  registerCommand({
    domain: "cards",
    command: "recent",
    description: "List recently generated intent cards",
    risk: "read",
    supportsDryRun: false,
    flags: [
      { name: "limit", type: "number", required: false, default: "10", description: "Max results" },
      { name: "basket", type: "string", required: false, enum: ["work", "health", "family", "wealth", "growth", "life"], description: "Filter by goal basket" },
      { name: "since", type: "string", required: false, description: "Time window (e.g. 7d, 24h, 2w)" },
    ],
  });
};
