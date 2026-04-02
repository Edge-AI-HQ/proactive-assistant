import { Command } from "commander";

import type { CliRuntimeInput, ResultRef } from "../../runtime.js";
import { getWorldItem, listWorldItems, searchNews } from "./service.js";

export const registerWorldCommands = (
  program: Command,
  runtime: CliRuntimeInput,
  resultRef: ResultRef,
): void => {
  const world = new Command("world");

  world
    .command("search")
    .requiredOption("--query <query>")
    .option("--provider <provider>")
    .option("--limit <limit>")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await searchNews(runtime, options);
    });

  world
    .command("list")
    .option("--query <query>")
    .option("--limit <limit>")
    .option("--since <since>")
    .option("--until <until>")
    .option("--after-id <afterId>")
    .option("--after-updated-at <afterUpdatedAt>")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await listWorldItems(runtime, options);
    });

  world
    .command("get")
    .requiredOption("--id <id>")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await getWorldItem(runtime, options.id);
    });

  program.addCommand(world);
};
