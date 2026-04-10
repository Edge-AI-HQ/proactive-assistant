import { callCore } from "../../output/adapter.js";
import { cards as coreCards } from "../../../core/index.js";
import type { CliRuntimeInput, RunCliResult } from "../../runtime.js";

export const listRecentGeneratedCards = async (
  runtime: CliRuntimeInput,
  input: {
    limit?: string;
    basket?: string;
    since?: string;
  },
): Promise<RunCliResult> =>
  callCore("cards", "recent", () => coreCards.listRecentGeneratedCards(runtime, input));
