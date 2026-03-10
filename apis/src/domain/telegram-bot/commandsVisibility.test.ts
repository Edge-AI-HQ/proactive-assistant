import test from "node:test";
import assert from "node:assert/strict";

test("shouldHideGuideBotCommands hides command menu in production only", async () => {
  const commandsModule = (await import("./commands.js")) as Record<string, unknown>;
  const shouldHideGuideBotCommands = commandsModule
    .shouldHideGuideBotCommands as
    | ((nodeEnv?: string) => boolean)
    | undefined;

  assert.equal(
    typeof shouldHideGuideBotCommands,
    "function",
    "commands.ts should export shouldHideGuideBotCommands",
  );

  assert.equal(shouldHideGuideBotCommands?.("production"), true);
  assert.equal(shouldHideGuideBotCommands?.("development"), false);
  assert.equal(shouldHideGuideBotCommands?.("test"), false);
});
