import { Command } from "commander";

import { registerCommand } from "../../registry.js";
import type { CliRuntimeInput, ResultRef } from "../../runtime.js";
import {
  setup,
  status,
  connectApp,
  waitForConnection,
  listConnections,
  searchTools,
  getToolSchema,
  execTool,
} from "./service.js";

export const registerPersonalCommands = (
  program: Command,
  runtime: CliRuntimeInput,
  resultRef: ResultRef,
): void => {
  const personal = new Command("personal").description(
    "Personal data: connect apps and access user data via Composio MCP",
  );

  // ── Key management ──

  personal
    .command("setup")
    .description("Save and validate your Composio consumer key")
    .requiredOption("--key <key>", "Composio consumer key (ck_...)")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await setup(runtime, options);
    });

  personal
    .command("status")
    .description("Check if a Composio consumer key is configured")
    .option("--json")
    .action(async () => {
      resultRef.current = await status(runtime);
    });

  // ── Connection management ──

  const connections = personal
    .command("connections")
    .description("Manage connected personal data sources");

  connections
    .command("list")
    .description("List connected apps and their status")
    .option("--toolkits <toolkits>", "comma-separated toolkit names to check (e.g. gmail,slack,notion)")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await listConnections(runtime, options);
    });

  personal
    .command("connect")
    .description("Initiate OAuth connection for an app (returns redirect URL)")
    .requiredOption("--toolkit <toolkit>", "app to connect (e.g. gmail, slack, notion)")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await connectApp(runtime, options);
    });

  personal
    .command("wait")
    .description("Wait for an OAuth connection to become active")
    .requiredOption("--toolkit <toolkit>", "app to wait for (e.g. gmail, slack, notion)")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await waitForConnection(runtime, options);
    });

  // ── Tool discovery & execution ──

  const tools = personal
    .command("tools")
    .description("Discover and inspect available Composio tools");

  tools
    .command("search")
    .description("Search available tools by keyword or toolkit")
    .requiredOption("--query <query>", "search keyword (e.g. 'fetch emails', 'list slack channels')")
    .option("--toolkit <toolkit>", "filter by toolkit name (e.g. gmail, slack, notion)")
    .option("--limit <limit>", "max results", "20")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await searchTools(runtime, options);
    });

  tools
    .command("schema")
    .description("Get the input schema for a specific tool")
    .requiredOption("--name <name>", "tool slug (e.g. GMAIL_FETCH_EMAILS)")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await getToolSchema(runtime, options);
    });

  personal
    .command("exec")
    .description("Execute a Composio tool and return results")
    .requiredOption("--tool <tool>", "tool slug (e.g. GMAIL_FETCH_EMAILS)")
    .option("--input <input>", "JSON object of tool arguments")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await execTool(runtime, options);
    });

  program.addCommand(personal);

  // ── Registry ──

  registerCommand({
    domain: "personal",
    command: "setup",
    description: "Save and validate Composio consumer key (ck_...)",
    risk: "write",
    supportsDryRun: false,
    flags: [
      { name: "key", type: "string", required: true, description: "Composio consumer key (ck_...)" },
    ],
  });

  registerCommand({
    domain: "personal",
    command: "status",
    description: "Check if Composio consumer key is configured",
    risk: "read",
    supportsDryRun: false,
    flags: [],
  });

  registerCommand({
    domain: "personal",
    command: "connections list",
    description: "List connected apps and their status via COMPOSIO_MANAGE_CONNECTIONS",
    risk: "read",
    supportsDryRun: false,
    flags: [
      { name: "toolkits", type: "string", required: false, description: "Comma-separated toolkit names (e.g. gmail,slack,notion)" },
    ],
  });

  registerCommand({
    domain: "personal",
    command: "connect",
    description: "Initiate OAuth connection for an app (returns redirect URL if not connected)",
    risk: "write",
    supportsDryRun: false,
    flags: [
      { name: "toolkit", type: "string", required: true, description: "App to connect (e.g. gmail, slack, notion)" },
    ],
  });

  registerCommand({
    domain: "personal",
    command: "wait",
    description: "Wait for an OAuth connection to become active via COMPOSIO_WAIT_FOR_CONNECTIONS",
    risk: "read",
    supportsDryRun: false,
    flags: [
      { name: "toolkit", type: "string", required: true, description: "App to wait for" },
    ],
  });

  registerCommand({
    domain: "personal",
    command: "tools search",
    description: "Search available Composio tools by use case via COMPOSIO_SEARCH_TOOLS",
    risk: "read",
    supportsDryRun: false,
    flags: [
      { name: "query", type: "string", required: true, description: "Search keyword (e.g. 'fetch emails')" },
      { name: "toolkit", type: "string", required: false, description: "Filter by toolkit (e.g. gmail, slack)" },
      { name: "limit", type: "number", required: false, default: "20", description: "Max results" },
    ],
  });

  registerCommand({
    domain: "personal",
    command: "tools schema",
    description: "Get tool input schema via COMPOSIO_GET_TOOL_SCHEMAS",
    risk: "read",
    supportsDryRun: false,
    flags: [
      { name: "name", type: "string", required: true, description: "Tool slug (e.g. GMAIL_FETCH_EMAILS)" },
    ],
  });

  registerCommand({
    domain: "personal",
    command: "exec",
    description: "Execute a Composio tool via COMPOSIO_MULTI_EXECUTE_TOOL",
    risk: "write",
    supportsDryRun: false,
    flags: [
      { name: "tool", type: "string", required: true, description: "Tool slug (e.g. GMAIL_FETCH_EMAILS)" },
      { name: "input", type: "string", required: false, description: "JSON object of tool arguments" },
    ],
  });
};
