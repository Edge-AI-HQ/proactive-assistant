import { Command } from "commander";

import type { CliRuntimeInput, ResultRef } from "../../runtime.js";
import { registerCommand } from "../../registry.js";
import {
  createProfile,
  deleteProfile,
  getProfile,
  listProfiles,
  updateProfile,
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
    .option("--json")
    .action(async (options) => {
      resultRef.current = await createProfile(runtime, options);
    });

  profile
    .command("get")
    .description("Get a profile by ID")
    .requiredOption("--id <id>")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await getProfile(runtime, options.id);
    });

  profile
    .command("list")
    .description("List all profiles")
    .option("--json")
    .action(async () => {
      resultRef.current = await listProfiles(runtime);
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
    ],
  });

  registerCommand({
    domain: "profile",
    command: "list",
    description: "List all profiles",
    risk: "read",
    supportsDryRun: false,
    flags: [],
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
};
