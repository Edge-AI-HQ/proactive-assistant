import { Command } from "commander";

import type { CliRuntimeInput, ResultRef } from "../../runtime.js";
import { registerCommand } from "../../registry.js";
import {
  addMemory,
  addProfileSignal,
  buildProfileSnapshot,
  getFacts,
  createProfile,
  closeGoal,
  deleteProfile,
  getConstraints,
  getPreferences,
  getProfile,
  listProfiles,
  listProfileInterests,
  listGoals,
  listMemory,
  removeMemory,
  rollupProfileSignals,
  searchMemory,
  setFact,
  setConstraint,
  setPreference,
  unsetFact,
  unsetConstraint,
  unsetPreference,
  updateProfile,
  upsertGoal,
} from "./service.js";

export const registerProfileCommands = (
  program: Command,
  runtime: CliRuntimeInput,
  resultRef: ResultRef,
): void => {
  const profile = new Command("profile").description("User profile: identity, preferences, goals, memory");

  profile
    .command("create")
    .description("Create a new profile")
    .requiredOption("--id <id>")
    .requiredOption("--display-name <displayName>")
    .option("--locale <locale>")
    .option("--timezone <timezone>")
    .option("--summary <summary>")
    .option("--metadata <metadata>")
    .option("--full")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await createProfile(runtime, options);
    });

  profile
    .command("get")
    .description("Get a profile by ID")
    .requiredOption("--id <id>")
    .option("--full")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await getProfile(runtime, options.id, options.full === true);
    });

  profile
    .command("list")
    .description("List all profiles")
    .option("--full")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await listProfiles(runtime, options.full === true);
    });

  profile
    .command("update")
    .description("Update an existing profile")
    .requiredOption("--id <id>")
    .option("--display-name <displayName>")
    .option("--locale <locale>")
    .option("--timezone <timezone>")
    .option("--summary <summary>")
    .option("--metadata <metadata>")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await updateProfile(runtime, options);
    });

  profile
    .command("delete")
    .description("Delete a profile")
    .requiredOption("--id <id>")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await deleteProfile(runtime, options.id);
    });

  const facts = profile.command("facts");
  facts
    .command("get")
    .option("--json")
    .action(async () => {
      resultRef.current = await getFacts(runtime);
    });

  facts
    .command("set")
    .requiredOption("--key <key>")
    .requiredOption("--value-json <valueJson>")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await setFact(runtime, options);
    });

  facts
    .command("unset")
    .requiredOption("--key <key>")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await unsetFact(runtime, options.key);
    });

  const preferences = profile.command("preferences");
  preferences
    .command("get")
    .option("--json")
    .action(async () => {
      resultRef.current = await getPreferences(runtime);
    });

  preferences
    .command("set")
    .requiredOption("--key <key>")
    .requiredOption("--value-json <valueJson>")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await setPreference(runtime, options);
    });

  preferences
    .command("unset")
    .requiredOption("--key <key>")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await unsetPreference(runtime, options.key);
    });

  const goals = profile.command("goals");
  goals
    .command("list")
    .option("--json")
    .action(async () => {
      resultRef.current = await listGoals(runtime);
    });

  goals
    .command("upsert")
    .requiredOption("--key <key>")
    .requiredOption("--title <title>")
    .option("--priority <priority>")
    .option("--summary <summary>")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await upsertGoal(runtime, options);
    });

  goals
    .command("close")
    .requiredOption("--key <key>")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await closeGoal(runtime, options.key);
    });

  const constraints = profile.command("constraints");
  constraints
    .command("get")
    .option("--json")
    .action(async () => {
      resultRef.current = await getConstraints(runtime);
    });

  constraints
    .command("set")
    .requiredOption("--key <key>")
    .requiredOption("--value-json <valueJson>")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await setConstraint(runtime, options);
    });

  constraints
    .command("unset")
    .requiredOption("--key <key>")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await unsetConstraint(runtime, options.key);
    });

  const memory = profile.command("memory");
  memory
    .command("list")
    .option("--json")
    .action(async () => {
      resultRef.current = await listMemory(runtime);
    });

  memory
    .command("add")
    .requiredOption("--kind <kind>")
    .requiredOption("--text <text>")
    .option("--tags-json <tagsJson>")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await addMemory(runtime, options);
    });

  memory
    .command("search")
    .requiredOption("--query <query>")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await searchMemory(runtime, options.query);
    });

  memory
    .command("remove")
    .requiredOption("--id <id>")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await removeMemory(runtime, options.id);
    });

  const signal = profile.command("signal");
  signal
    .command("add")
    .requiredOption("--id <id>")
    .requiredOption("--kind <kind>")
    .requiredOption("--target-type <targetType>")
    .requiredOption("--target-key <targetKey>")
    .requiredOption("--source <source>")
    .option("--value <value>")
    .option("--occurred-at <occurredAt>")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await addProfileSignal(runtime, options);
    });

  signal
    .command("rollup")
    .requiredOption("--id <id>")
    .option("--since <since>")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await rollupProfileSignals(runtime, options);
    });

  const interests = profile.command("interests");
  interests
    .command("list")
    .requiredOption("--id <id>")
    .option("--kind <kind>")
    .option("--limit <limit>")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await listProfileInterests(runtime, options);
    });

  const snapshot = profile.command("snapshot");
  snapshot
    .command("build")
    .requiredOption("--id <id>")
    .option("--view <view>", "snapshot view", "ranking")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await buildProfileSnapshot(runtime, options);
    });

  program.addCommand(profile);

  registerCommand({
    domain: "profile",
    command: "create",
    description: "Create a new user profile",
    risk: "write",
    supportsDryRun: true,
    flags: [
      { name: "id", type: "string", required: true, description: "Profile ID" },
      { name: "display-name", type: "string", required: true, description: "Display name" },
      { name: "locale", type: "string", required: false, description: "Locale (e.g. en-US)" },
      { name: "timezone", type: "string", required: false, description: "Timezone (e.g. Asia/Shanghai)" },
      { name: "summary", type: "string", required: false, description: "Profile summary" },
      { name: "metadata", type: "string", required: false, description: "JSON metadata object" },
      { name: "full", type: "boolean", required: false, description: "Return the full stored record" },
    ],
  });

  registerCommand({
    domain: "profile",
    command: "get",
    description: "Get a profile by ID",
    risk: "read",
    supportsDryRun: false,
    flags: [
      { name: "id", type: "string", required: true, description: "Profile ID" },
      { name: "full", type: "boolean", required: false, description: "Return the full stored record" },
    ],
  });

  registerCommand({
    domain: "profile",
    command: "list",
    description: "List all profiles",
    risk: "read",
    supportsDryRun: false,
    flags: [
      { name: "full", type: "boolean", required: false, description: "Return the full stored record" },
    ],
  });

  registerCommand({
    domain: "profile",
    command: "update",
    description: "Update an existing profile",
    risk: "write",
    supportsDryRun: true,
    flags: [
      { name: "id", type: "string", required: true, description: "Profile ID" },
      { name: "display-name", type: "string", required: false, description: "Display name" },
      { name: "locale", type: "string", required: false, description: "Locale" },
      { name: "timezone", type: "string", required: false, description: "Timezone" },
      { name: "summary", type: "string", required: false, description: "Profile summary" },
      { name: "metadata", type: "string", required: false, description: "JSON metadata object" },
    ],
  });

  registerCommand({
    domain: "profile",
    command: "delete",
    description: "Delete a profile by ID",
    risk: "write",
    supportsDryRun: false,
    flags: [
      { name: "id", type: "string", required: true, description: "Profile ID" },
    ],
  });

  registerCommand({
    domain: "profile",
    command: "facts get",
    description: "Get stable profile facts for the default profile",
    risk: "read",
    supportsDryRun: false,
    flags: [],
  });

  registerCommand({
    domain: "profile",
    command: "facts set",
    description: "Set a stable fact on the default profile",
    risk: "write",
    supportsDryRun: false,
    flags: [
      { name: "key", type: "string", required: true, description: "Fact key" },
      { name: "value-json", type: "string", required: true, description: "JSON-encoded fact value" },
    ],
  });

  registerCommand({
    domain: "profile",
    command: "facts unset",
    description: "Remove a stable fact from the default profile",
    risk: "write",
    supportsDryRun: false,
    flags: [{ name: "key", type: "string", required: true, description: "Fact key" }],
  });

  registerCommand({
    domain: "profile",
    command: "preferences get",
    description: "Get stored preferences for the default profile",
    risk: "read",
    supportsDryRun: false,
    flags: [],
  });

  registerCommand({
    domain: "profile",
    command: "preferences set",
    description: "Set a preference on the default profile",
    risk: "write",
    supportsDryRun: false,
    flags: [
      { name: "key", type: "string", required: true, description: "Preference key" },
      { name: "value-json", type: "string", required: true, description: "JSON-encoded preference value" },
    ],
  });

  registerCommand({
    domain: "profile",
    command: "preferences unset",
    description: "Remove a preference from the default profile",
    risk: "write",
    supportsDryRun: false,
    flags: [{ name: "key", type: "string", required: true, description: "Preference key" }],
  });

  registerCommand({
    domain: "profile",
    command: "goals list",
    description: "List goals for the default profile",
    risk: "read",
    supportsDryRun: false,
    flags: [],
  });

  registerCommand({
    domain: "profile",
    command: "goals upsert",
    description: "Create or update a goal on the default profile",
    risk: "write",
    supportsDryRun: false,
    flags: [
      { name: "key", type: "string", required: true, description: "Goal key" },
      { name: "title", type: "string", required: true, description: "Goal title" },
      { name: "priority", type: "string", required: false, description: "Goal priority" },
      { name: "summary", type: "string", required: false, description: "Goal summary" },
    ],
  });

  registerCommand({
    domain: "profile",
    command: "goals close",
    description: "Close an existing goal on the default profile",
    risk: "write",
    supportsDryRun: false,
    flags: [{ name: "key", type: "string", required: true, description: "Goal key" }],
  });

  registerCommand({
    domain: "profile",
    command: "constraints get",
    description: "Get active constraints for the default profile",
    risk: "read",
    supportsDryRun: false,
    flags: [],
  });

  registerCommand({
    domain: "profile",
    command: "constraints set",
    description: "Set a constraint on the default profile",
    risk: "write",
    supportsDryRun: false,
    flags: [
      { name: "key", type: "string", required: true, description: "Constraint key" },
      { name: "value-json", type: "string", required: true, description: "JSON-encoded constraint value" },
    ],
  });

  registerCommand({
    domain: "profile",
    command: "constraints unset",
    description: "Remove a constraint from the default profile",
    risk: "write",
    supportsDryRun: false,
    flags: [{ name: "key", type: "string", required: true, description: "Constraint key" }],
  });

  registerCommand({
    domain: "profile",
    command: "memory list",
    description: "List profile memory entries for the default profile",
    risk: "read",
    supportsDryRun: false,
    flags: [],
  });

  registerCommand({
    domain: "profile",
    command: "memory add",
    description: "Add a memory entry to the default profile",
    risk: "write",
    supportsDryRun: false,
    flags: [
      { name: "kind", type: "string", required: true, description: "Memory kind" },
      { name: "text", type: "string", required: true, description: "Memory text" },
      { name: "tags-json", type: "string", required: false, description: "JSON string array of tags" },
    ],
  });

  registerCommand({
    domain: "profile",
    command: "memory search",
    description: "Search profile memory entries for the default profile",
    risk: "read",
    supportsDryRun: false,
    flags: [{ name: "query", type: "string", required: true, description: "Search query" }],
  });

  registerCommand({
    domain: "profile",
    command: "memory remove",
    description: "Remove a memory entry from the default profile",
    risk: "write",
    supportsDryRun: false,
    flags: [{ name: "id", type: "string", required: true, description: "Memory entry ID" }],
  });

  registerCommand({
    domain: "profile",
    command: "signal add",
    description: "Record a learning signal for a profile",
    risk: "write",
    supportsDryRun: false,
    flags: [
      { name: "id", type: "string", required: true, description: "Profile ID" },
      { name: "kind", type: "string", required: true, description: "Signal kind" },
      { name: "target-type", type: "string", required: true, description: "Signal target type" },
      { name: "target-key", type: "string", required: true, description: "Signal target key" },
      { name: "source", type: "string", required: true, description: "Signal source" },
      { name: "value", type: "number", required: false, description: "Optional signal strength" },
      { name: "occurred-at", type: "string", required: false, description: "Signal timestamp (ISO-8601)" },
    ],
  });

  registerCommand({
    domain: "profile",
    command: "signal rollup",
    description: "Roll up raw profile signals into stable interests",
    risk: "write",
    supportsDryRun: false,
    flags: [
      { name: "id", type: "string", required: true, description: "Profile ID" },
      { name: "since", type: "string", required: false, description: "Lookback window or ISO-8601 timestamp" },
    ],
  });

  registerCommand({
    domain: "profile",
    command: "interests list",
    description: "List rolled-up interests for a profile",
    risk: "read",
    supportsDryRun: false,
    flags: [
      { name: "id", type: "string", required: true, description: "Profile ID" },
      { name: "kind", type: "string", required: false, description: "Interest kind filter" },
      { name: "limit", type: "number", required: false, description: "Maximum result count" },
    ],
  });

  registerCommand({
    domain: "profile",
    command: "snapshot build",
    description: "Build a compact snapshot for profile-based ranking",
    risk: "write",
    supportsDryRun: false,
    flags: [
      { name: "id", type: "string", required: true, description: "Profile ID" },
      { name: "view", type: "string", required: false, description: "Snapshot view name" },
    ],
  });
};
