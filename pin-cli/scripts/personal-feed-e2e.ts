import {
  buildPersonalFeedE2ERuntime,
  runPersonalFeedE2E,
} from "../src/domains/personal/e2e.js";

const parseNumber = (raw: string | undefined, fallback: number): number => {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const main = async () => {
  const runtime = buildPersonalFeedE2ERuntime();
  const toolkit = process.env.PIN_PERSONAL_E2E_TOOLKIT ?? "gmail";

  if (!runtime.env.COMPOSIO_API_KEY) {
    throw new Error("缺少 COMPOSIO_API_KEY");
  }

  if (!runtime.env.OPENAI_API_KEY) {
    throw new Error("缺少 OPENAI_API_KEY");
  }

  const summary = await runPersonalFeedE2E(runtime, {
    toolkit,
    lookbackDays: parseNumber(process.env.PIN_PERSONAL_E2E_LOOKBACK_DAYS, 180),
    timelineLimit: parseNumber(process.env.PIN_PERSONAL_E2E_TIMELINE_LIMIT, 10),
    searchLimit: parseNumber(process.env.PIN_PERSONAL_E2E_SEARCH_LIMIT, 5),
    indexLimit: parseNumber(process.env.PIN_PERSONAL_E2E_INDEX_LIMIT, 200),
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        summary,
      },
      null,
      2,
    ),
  );
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : "unknown e2e failure";
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: {
          message,
        },
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
