import test from "node:test";
import assert from "node:assert/strict";

test("buildGuideBotStartWelcome returns landing image, intro copy, and mini app button", async () => {
  const commandsModule = (await import("./commands.js")) as Record<string, unknown>;
  const buildGuideBotStartWelcome = commandsModule.buildGuideBotStartWelcome as
    | ((miniAppUrl?: string) => {
        imagePath: string;
        caption: string;
        buttonText: string;
        miniAppUrl: string;
      })
    | undefined;

  assert.equal(
    typeof buildGuideBotStartWelcome,
    "function",
    "commands.ts should export buildGuideBotStartWelcome",
  );

  const payload = buildGuideBotStartWelcome?.(
    "https://le-unforsaking-jenette.ngrok-free.dev/mini/",
  );

  assert.ok(payload);
  assert.match(payload.imagePath, /telegram-start-landing\.png$/);
  assert.match(payload.caption, /PIN Claw/i);
  assert.match(payload.caption, /personal AI assistant/i);
  assert.match(payload.caption, /start exploring PIN Claw/i);
  assert.match(payload.caption, /Try for PIN Claw/i);
  assert.equal(payload.buttonText, "Try for PIN Claw");
  assert.equal(
    payload.miniAppUrl,
    "https://le-unforsaking-jenette.ngrok-free.dev/mini/",
  );
});
