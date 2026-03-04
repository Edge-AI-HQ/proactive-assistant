import {
  CREATE_ASSISTANT_COMMAND,
  GATEWAY_COMMAND,
  LIST_ASSISTANT_COMMAND,
  SUBSCRIBE_COMMAND,
  VNC_ACCESS_COMMAND,
} from "../telegram-bot/guideCommandList.js";

const GUIDE_BOT_COMMANDS = new Set([
  "start",
  CREATE_ASSISTANT_COMMAND,
  LIST_ASSISTANT_COMMAND,
  SUBSCRIBE_COMMAND,
  GATEWAY_COMMAND,
  VNC_ACCESS_COMMAND,
  "help",
]);

export function isGuideBotCommandText(text: string): boolean {
  if (!text.startsWith("/")) return false;
  const command = text.slice(1).split(/[\s@]/)[0]?.toLowerCase();
  return GUIDE_BOT_COMMANDS.has(command || "");
}
