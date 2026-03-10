import test from "node:test";
import assert from "node:assert/strict";

test("buildGuideBotFallbackMessage returns english copy and mini app button", async () => {
  const botModule = (await import("./bot.js")) as Record<string, unknown>;
  const buildGuideBotFallbackMessage = botModule.buildGuideBotFallbackMessage as
    | (() => {
        text: string;
        buttonText: string;
        miniAppUrl: string;
      })
    | undefined;

  assert.equal(
    typeof buildGuideBotFallbackMessage,
    "function",
    "bot.ts should export buildGuideBotFallbackMessage",
  );

  const payload = buildGuideBotFallbackMessage?.();

  assert.ok(payload);
  assert.equal(
    payload.text,
    "Please click the Mini App button to experience PIN Claw.",
  );
  assert.equal(payload.buttonText, "Try for PIN Claw");
  assert.match(payload.miniAppUrl, /\/mini\/$/);
});
