import { callCore } from "../../output/adapter.js";
import { profile as coreProfile } from "@pin-ai/core";
import type { CliRuntimeInput, RunCliResult } from "../../runtime.js";

export const DEFAULT_PROFILE_ID = coreProfile.DEFAULT_PROFILE_ID;

export const createProfile = async (
  runtime: CliRuntimeInput,
  input: {
    id: string;
    displayName: string;
    locale?: string;
    timezone?: string;
    summary?: string;
    metadata?: string;
    full?: boolean;
  },
): Promise<RunCliResult> =>
  callCore("profile", "create", () => coreProfile.createProfile(runtime, input));

export const getProfile = async (
  runtime: CliRuntimeInput,
  id: string,
  full = false,
): Promise<RunCliResult> =>
  callCore("profile", "get", () => coreProfile.getProfile(runtime, id, full));

export const getPreferences = async (
  runtime: CliRuntimeInput,
): Promise<RunCliResult> =>
  callCore("profile.preferences", "get", () => coreProfile.getPreferences(runtime));

export const getFacts = async (
  runtime: CliRuntimeInput,
): Promise<RunCliResult> =>
  callCore("profile.facts", "get", () => coreProfile.getFacts(runtime));

export const setFact = async (
  runtime: CliRuntimeInput,
  input: { key: string; valueJson: string },
): Promise<RunCliResult> =>
  callCore("profile.facts", "set", () => coreProfile.setFact(runtime, input));

export const unsetFact = async (
  runtime: CliRuntimeInput,
  key: string,
): Promise<RunCliResult> =>
  callCore("profile.facts", "unset", () => coreProfile.unsetFact(runtime, key));

export const setPreference = async (
  runtime: CliRuntimeInput,
  input: { key: string; valueJson: string },
): Promise<RunCliResult> =>
  callCore("profile.preferences", "set", () => coreProfile.setPreference(runtime, input));

export const unsetPreference = async (
  runtime: CliRuntimeInput,
  key: string,
): Promise<RunCliResult> =>
  callCore("profile.preferences", "unset", () => coreProfile.unsetPreference(runtime, key));

export const listGoals = async (
  runtime: CliRuntimeInput,
): Promise<RunCliResult> =>
  callCore("profile.goals", "list", () => coreProfile.listGoals(runtime));

export const listMemory = async (
  runtime: CliRuntimeInput,
): Promise<RunCliResult> =>
  callCore("profile.memory", "list", () => coreProfile.listMemory(runtime));

export const addMemory = async (
  runtime: CliRuntimeInput,
  input: { kind: string; text: string; tagsJson?: string },
): Promise<RunCliResult> =>
  callCore("profile.memory", "add", () => coreProfile.addMemory(runtime, input));

export const searchMemory = async (
  runtime: CliRuntimeInput,
  query: string,
): Promise<RunCliResult> =>
  callCore("profile.memory", "search", () => coreProfile.searchMemory(runtime, query));

export const removeMemory = async (
  runtime: CliRuntimeInput,
  entryId: string,
): Promise<RunCliResult> =>
  callCore("profile.memory", "remove", () => coreProfile.removeMemory(runtime, entryId));

export const upsertGoal = async (
  runtime: CliRuntimeInput,
  input: { key: string; title: string; priority?: string; summary?: string },
): Promise<RunCliResult> =>
  callCore("profile.goals", "upsert", () => coreProfile.upsertGoal(runtime, input));

export const closeGoal = async (
  runtime: CliRuntimeInput,
  key: string,
): Promise<RunCliResult> =>
  callCore("profile.goals", "close", () => coreProfile.closeGoal(runtime, key));

export const getConstraints = async (
  runtime: CliRuntimeInput,
): Promise<RunCliResult> =>
  callCore("profile.constraints", "get", () => coreProfile.getConstraints(runtime));

export const setConstraint = async (
  runtime: CliRuntimeInput,
  input: { key: string; valueJson: string },
): Promise<RunCliResult> =>
  callCore("profile.constraints", "set", () => coreProfile.setConstraint(runtime, input));

export const unsetConstraint = async (
  runtime: CliRuntimeInput,
  key: string,
): Promise<RunCliResult> =>
  callCore("profile.constraints", "unset", () => coreProfile.unsetConstraint(runtime, key));

export const listProfiles = async (
  runtime: CliRuntimeInput,
  full = false,
): Promise<RunCliResult> =>
  callCore("profile", "list", () => coreProfile.listProfiles(runtime, full));

export const updateProfile = async (
  runtime: CliRuntimeInput,
  input: {
    id: string;
    displayName?: string;
    locale?: string;
    timezone?: string;
    summary?: string;
    metadata?: string;
  },
): Promise<RunCliResult> =>
  callCore("profile", "update", () => coreProfile.updateProfile(runtime, input));

export const addProfileSignal = async (
  runtime: CliRuntimeInput,
  input: {
    id: string;
    kind: string;
    targetType: string;
    targetKey: string;
    value?: string;
    source: string;
    occurredAt?: string;
  },
): Promise<RunCliResult> =>
  callCore("profile.signal", "add", () => coreProfile.addProfileSignal(runtime, input));

export const rollupProfileSignals = async (
  runtime: CliRuntimeInput,
  input: {
    id: string;
    since?: string;
  },
): Promise<RunCliResult> =>
  callCore("profile.signal", "rollup", () => coreProfile.rollupProfileSignals(runtime, input));

export const listProfileInterests = async (
  runtime: CliRuntimeInput,
  input: {
    id: string;
    kind?: string;
    limit?: string;
  },
): Promise<RunCliResult> =>
  callCore("profile.interests", "list", () => coreProfile.listProfileInterests(runtime, input));

export const buildProfileSnapshot = async (
  runtime: CliRuntimeInput,
  input: {
    id: string;
    view: string;
  },
): Promise<RunCliResult> =>
  callCore("profile.snapshot", "build", () => coreProfile.buildProfileSnapshot(runtime, input));

export const deleteProfile = async (
  runtime: CliRuntimeInput,
  id: string,
): Promise<RunCliResult> =>
  callCore("profile", "delete", () => coreProfile.deleteProfile(runtime, id));
