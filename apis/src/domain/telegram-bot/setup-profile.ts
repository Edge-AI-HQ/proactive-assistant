/**
 * One-off script to configure the Telegram bot welcome screen.
 *
 * What it does via Bot API:
 *   - setMyDescription      → text shown before user taps Start
 *   - setMyShortDescription → text in bot profile / share card
 *
 * What still requires @BotFather:
 *   - /setdescriptionpicture → the large banner image on the Start screen
 *     (no Bot API method exists for this)
 *
 * Usage:
 *   npx tsx apis/src/domain/telegram-bot/setup-profile.ts
 */

import { Bot } from "grammy";
import { config } from "../common/config.js";

const BOT_DESCRIPTION = `Your Personal Intelligence Network

OpenClaw is your AI assistant running on PIN AI's decentralized infrastructure. It connects to Telegram, manages tasks, and works for you 24/7.

Tap Start to set up your assistant.`;

const BOT_SHORT_DESCRIPTION =
  "PIN AI OpenClaw – Your always-on AI assistant powered by decentralized intelligence.";

async function main() {
  const token = config.telegram.token;
  if (!token) {
    console.error("Missing TELEGRAM_BOT_TOKEN. Set it in .env or environment.");
    process.exit(1);
  }

  const bot = new Bot(token);

  // 1. Set description (shown before user taps Start)
  console.log("Setting bot description…");
  await bot.api.setMyDescription(BOT_DESCRIPTION);
  console.log("✓ Description set.");

  // 2. Set short description (shown in bot profile / share card)
  console.log("Setting short description…");
  await bot.api.setMyShortDescription(BOT_SHORT_DESCRIPTION);
  console.log("✓ Short description set.");

  // 3. Banner image instructions
  console.log("\n── Manual step (via @BotFather) ──");
  console.log("The large banner image on the Start screen can only be set via BotFather:");
  console.log("  1. Open @BotFather in Telegram");
  console.log("  2. Send /setdescriptionpicture");
  console.log("  3. Choose your bot");
  console.log("  4. Send the banner image");

  console.log("\nDone! Open the bot in Telegram to verify.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Failed to set bot profile:", err);
  process.exit(1);
});
