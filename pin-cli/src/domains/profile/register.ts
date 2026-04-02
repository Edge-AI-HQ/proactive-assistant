import { Command } from "commander";

import type { CliRuntimeInput, ResultRef } from "../../runtime.js";
import {
  getFacts,
  createProfile,
  closeGoal,
  deleteProfile,
  getConstraints,
  getPreferences,
  getProfile,
  listProfiles,
  listGoals,
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
  const profile = new Command("profile");

  profile
    .command("create")
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
    .requiredOption("--id <id>")
    .option("--json")
    .action(async (options) => {
      resultRef.current = await getProfile(runtime, options.id);
    });

  profile
    .command("list")
    .option("--json")
    .action(async () => {
      resultRef.current = await listProfiles(runtime);
    });

  profile
    .command("update")
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

  program.addCommand(profile);
};
