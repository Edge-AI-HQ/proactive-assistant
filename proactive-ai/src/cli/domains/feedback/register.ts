import { Command } from "commander";

import type { CliRuntimeInput, ResultRef } from "../../runtime.js";
import { registerCommand } from "../../registry.js";
import {
  logFeedback,
  listFeedback,
  getFeedback,
  statsFeedback,
} from "./service.js";

export const registerFeedbackCommands = (
  program: Command,
  runtime: CliRuntimeInput,
  resultRef: ResultRef,
): void => {
  const feedback = new Command("feedback").description(
    "User feedback: record and query feedback events for Intent Cards",
  );

  feedback
    .command("log")
    .description("Record a feedback event")
    .requiredOption(
      "--kind <kind>",
      "event kind: card_open | card_action | explicit_rating | dismiss | snooze | text_feedback",
    )
    .option("--action <action>", "action: confirm | modify | later | thumbs_up | thumbs_down | open_detail | click_cta")
    .option("--push-id <pushId>", "related push record ID")
    .option("--intent-card-id <intentCardId>", "related intent card ID")
    .option("--conversation-id <conversationId>", "related conversation ID")
    .option("--message-id <messageId>", "related message ID")
    .option("--source <source>", "source: user_direct | user_derived | agent_analysis")
    .option("--basket <basket>", "goal basket: work | health | family | wealth | growth | life")
    .option("--channel <channel>", "channel: telegram | web | mobile | im")
    .option("--value <value>", "short feedback value")
    .option("--text <text>", "text feedback content")
    .option("--metadata <json>", "JSON metadata for correlation/context")
    .option("--at <timestamp>", "event timestamp (ISO 8601)")
    .option("--dry-run", "preview without saving")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await logFeedback(runtime, options);
    });

  feedback
    .command("list")
    .description("List feedback events")
    .option("--since <duration>", "time window (e.g. 7d, 24h, 2w)")
    .option("--kind <kind>", "filter by event kind")
    .option("--action <action>", "filter by action")
    .option("--source <source>", "filter by source")
    .option("--basket <basket>", "filter by goal basket")
    .option("--channel <channel>", "filter by channel")
    .option("--push-id <pushId>", "filter by push record ID")
    .option("--intent-card-id <intentCardId>", "filter by intent card ID")
    .option("--limit <n>", "max results", "50")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await listFeedback(runtime, options);
    });

  feedback
    .command("get")
    .description("Get a single feedback event")
    .requiredOption("--id <id>", "feedback event ID")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await getFeedback(runtime, options);
    });

  feedback
    .command("stats")
    .description("Aggregated feedback statistics")
    .option("--since <duration>", "time window (e.g. 7d, 24h, 2w)")
    .option("--basket <basket>", "filter by goal basket")
    .option("--channel <channel>", "filter by channel")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await statsFeedback(runtime, options);
    });

  program.addCommand(feedback);

  registerCommand({
    domain: "feedback",
    command: "log",
    description: "Record a feedback event (card_open, card_action, explicit_rating, dismiss, snooze, text_feedback)",
    risk: "write",
    supportsDryRun: true,
    flags: [
      { name: "kind", type: "string", required: true, enum: ["card_open", "card_action", "explicit_rating", "dismiss", "snooze", "text_feedback"], description: "Event kind" },
      { name: "action", type: "string", required: false, enum: ["confirm", "modify", "later", "thumbs_up", "thumbs_down", "open_detail", "click_cta"], description: "Action taken" },
      { name: "push-id", type: "string", required: false, description: "Related push record ID" },
      { name: "intent-card-id", type: "string", required: false, description: "Related intent card ID" },
      { name: "conversation-id", type: "string", required: false, description: "Related conversation ID" },
      { name: "message-id", type: "string", required: false, description: "Related message ID" },
      { name: "source", type: "string", required: false, enum: ["user_direct", "user_derived", "agent_analysis"], description: "Feedback source" },
      { name: "basket", type: "string", required: false, enum: ["work", "health", "family", "wealth", "growth", "life"], description: "Goal basket" },
      { name: "channel", type: "string", required: false, enum: ["telegram", "web", "mobile", "im"], description: "Channel" },
      { name: "value", type: "string", required: false, description: "Short feedback value" },
      { name: "text", type: "string", required: false, description: "Text feedback content" },
      { name: "metadata", type: "string", required: false, description: "JSON metadata for correlation/context" },
      { name: "at", type: "string", required: false, description: "Event timestamp (ISO 8601)" },
    ],
  });

  registerCommand({
    domain: "feedback",
    command: "list",
    description: "List feedback events with filters",
    risk: "read",
    supportsDryRun: false,
    flags: [
      { name: "since", type: "string", required: false, description: "Time window (e.g. 7d, 24h, 2w)" },
      { name: "kind", type: "string", required: false, description: "Filter by event kind" },
      { name: "action", type: "string", required: false, description: "Filter by action" },
      { name: "source", type: "string", required: false, description: "Filter by source" },
      { name: "basket", type: "string", required: false, description: "Filter by goal basket" },
      { name: "channel", type: "string", required: false, description: "Filter by channel" },
      { name: "push-id", type: "string", required: false, description: "Filter by push record ID" },
      { name: "intent-card-id", type: "string", required: false, description: "Filter by intent card ID" },
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

  registerCommand({
    domain: "feedback",
    command: "stats",
    description: "Aggregated feedback statistics (gross hit, qualified hit, distributions)",
    risk: "read",
    supportsDryRun: false,
    flags: [
      { name: "since", type: "string", required: false, description: "Time window (e.g. 7d, 24h, 2w)" },
      { name: "basket", type: "string", required: false, description: "Filter by goal basket" },
      { name: "channel", type: "string", required: false, description: "Filter by channel" },
    ],
  });
};
