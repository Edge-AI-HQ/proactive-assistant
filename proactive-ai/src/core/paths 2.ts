/**
 * Canonical path resolution for Proactive AI.
 *
 * Single source of truth. Every module that needs a home-relative path
 * imports from here — no more scattered `homedir()` + string concat.
 *
 * Layout under ~/.openclaw-proactive-ai/:
 *   data/pin.db              — SQLite database
 *   index/world.lancedb      — LanceDB vector index
 *   local-settings.json      — Composio keys, generation language, etc.
 *   composio-user-id          — Persisted Composio user UUID
 *   openclaw.json             — OpenClaw gateway config
 *   agents/                   — OpenClaw agent profiles & auth
 *
 * Override:  PIN_DATA_ROOT env var replaces the entire root.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import type { CoreContext } from "./context.js";

/** Default profile directory name (matches `openclaw --profile proactive-ai`). */
const PROFILE_DIR_NAME = ".openclaw-proactive-ai";

/**
 * Resolve the application data root.
 *
 * Priority:
 *   1. Explicit `PIN_DATA_ROOT` env var (for tests / custom layouts)
 *   2. `~/.openclaw-proactive-ai`
 */
export function resolveAppRoot(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  home: string = homedir(),
): string {
  return env.PIN_DATA_ROOT || join(home, PROFILE_DIR_NAME);
}

/** Convenience: resolve from a CoreContext (used heavily by domain services). */
export const resolveAppRootFromCtx = (ctx: CoreContext): string =>
  resolveAppRoot(ctx.env, ctx.homeDir);

/** Paths derived from the app root — pure functions, no I/O. */
export const appPaths = {
  /** SQLite database directory. */
  dataDir: (root: string) => join(root, "data"),

  /** Main SQLite database. */
  pinDb: (root: string) => join(root, "data", "pin.db"),

  /** LanceDB vector index directory. */
  worldIndex: (root: string) => join(root, "index", "world.lancedb"),

  /** Local settings (Composio, generation language, autoGenerate, etc.). */
  localSettings: (root: string) => join(root, "local-settings.json"),

  /** Persisted Composio user UUID. */
  composioUserId: (root: string) => join(root, "composio-user-id"),

  /** OpenClaw gateway config. */
  openclawConfig: (root: string) => join(root, "openclaw.json"),

  /** Auth profiles (API keys). */
  authProfiles: (root: string) =>
    join(root, "agents", "main", "agent", "auth-profiles.json"),
} as const;
