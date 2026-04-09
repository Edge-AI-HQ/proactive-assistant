import {
  getDefaultProfile,
  getDefaultProfileConstraints,
  getDefaultProfileFacts,
  getDefaultProfileGoals,
  getDefaultProfilePreferences,
  getDefaultProfileSnapshot,
  getPersonalStatus,
  listFeedbackSummary,
  listPersonalConnections,
  listPushHistorySummary,
  shortlistWorldItemsForDefaultProfile,
} from "./data-access.js";
import type { TraceEventRecord } from "./trace.js";

export interface IncrementalContextPayload {
  runToken: string | null;
  generatedAt: string;
  items: {
    world: Array<Record<string, unknown>>;
    personal: Array<Record<string, unknown>>;
  };
  meta: {
    pendingCount: number;
    oldestPendingAt: string | null;
  };
}

export interface ContextBrief {
  profileStatus: {
    exists: boolean;
    displayName: string | null;
    goalsCount: number;
    factsCount: number;
    preferenceCount: number;
    constraintCount: number;
    snapshotAvailable: boolean;
  };
  personalStatus: {
    configured: boolean;
    mode: string | null;
    connectedCount: number;
    connectedApps: string[];
  };
  worldStatus: {
    shortlistCount: number;
    incrementalWorldCount: number;
    available: boolean;
  };
  recentSignals: {
    pushes: unknown[];
    feedback: unknown[];
    incremental: {
      world: Array<Record<string, unknown>>;
      personal: Array<Record<string, unknown>>;
    };
    runToken: string | null;
    generatedAt: string | null;
    pendingCount: number;
    oldestPendingAt: string | null;
  };
  knownGaps: string[];
  candidateWorldItems: unknown[];
  dedupContext: {
    profile: Record<string, unknown> | null;
    personal: {
      status: Record<string, unknown>;
      connections: unknown[];
    };
    world: {
      shortlist: unknown[];
    };
    recentSignals: {
      pushes: unknown[];
      feedback: unknown[];
      incremental: {
        world: Array<Record<string, unknown>>;
        personal: Array<Record<string, unknown>>;
      };
    };
  };
}

export interface BuildContextBriefInput {
  incrementalContext?: string;
  onTrace?: (event: TraceEventRecord) => void;
}

function nowIso(): string {
  return new Date().toISOString();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function inferConnectedApp(connection: unknown): string | null {
  const record = asRecord(connection);
  const toolkit = record.toolkit;
  if (typeof toolkit === "string" && toolkit) return toolkit;
  const id = record.id;
  return typeof id === "string" && id ? id : null;
}

function inferConfigured(status: Record<string, unknown>): boolean {
  const configured = status.configured;
  return typeof configured === "boolean" ? configured : false;
}

function inferMode(status: Record<string, unknown>): string | null {
  const mode = status.mode;
  return typeof mode === "string" ? mode : null;
}

export function parseIncrementalContext(raw?: string): IncrementalContextPayload | null {
  if (!raw?.trim()) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<IncrementalContextPayload>;
    return {
      runToken: typeof parsed.runToken === "string" || parsed.runToken === null ? parsed.runToken : null,
      generatedAt: typeof parsed.generatedAt === "string" ? parsed.generatedAt : nowIso(),
      items: {
        world: Array.isArray(parsed.items?.world) ? parsed.items!.world as Array<Record<string, unknown>> : [],
        personal: Array.isArray(parsed.items?.personal) ? parsed.items!.personal as Array<Record<string, unknown>> : [],
      },
      meta: {
        pendingCount: typeof parsed.meta?.pendingCount === "number" ? parsed.meta.pendingCount : 0,
        oldestPendingAt: typeof parsed.meta?.oldestPendingAt === "string" || parsed.meta?.oldestPendingAt === null
          ? parsed.meta.oldestPendingAt
          : null,
      },
    };
  } catch {
    return null;
  }
}

export async function buildContextBrief(input: BuildContextBriefInput): Promise<ContextBrief> {
  const emit = input.onTrace ?? (() => {});
  const incremental = parseIncrementalContext(input.incrementalContext) ?? {
    runToken: null,
    generatedAt: null as string | null,
    items: { world: [], personal: [] },
    meta: { pendingCount: 0, oldestPendingAt: null },
  };

  async function withTrace<T>(name: string, task: () => Promise<T>): Promise<T> {
    emit({
      timestamp: nowIso(),
      phase: "context",
      kind: "context.source.start",
      name,
    });
    const startedAt = Date.now();
    try {
      const result = await task();
      emit({
        timestamp: nowIso(),
        phase: "context",
        kind: "context.source.finish",
        name,
        durationMs: Date.now() - startedAt,
        attrs: result && typeof result === "object"
          ? { count: Array.isArray(result) ? result.length : Object.keys(result as Record<string, unknown>).length }
          : undefined,
      });
      return result;
    } catch (error) {
      emit({
        timestamp: nowIso(),
        phase: "context",
        kind: "context.source.finish",
        name,
        durationMs: Date.now() - startedAt,
        attrs: { error: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
  }

  const [
    profileRecord,
    profileFacts,
    profileGoals,
    profilePreferences,
    profileConstraints,
    profileSnapshot,
    personalStatus,
    personalConnections,
    recentPushes,
    recentFeedback,
    worldShortlist,
  ] = await Promise.all([
    withTrace("profile", () => getDefaultProfile()),
    withTrace("profile.facts", () => getDefaultProfileFacts()),
    withTrace("profile.goals", () => getDefaultProfileGoals()),
    withTrace("profile.preferences", () => getDefaultProfilePreferences()),
    withTrace("profile.constraints", () => getDefaultProfileConstraints()),
    withTrace("profile.snapshot", () => getDefaultProfileSnapshot()),
    withTrace("personal.status", () => getPersonalStatus()),
    withTrace("personal.connections", () => listPersonalConnections()),
    withTrace("push", () => listPushHistorySummary({ since: "14d", limit: "12" })),
    withTrace("feedback", () => listFeedbackSummary({ since: "14d", limit: "12" })),
    withTrace("world", () => shortlistWorldItemsForDefaultProfile(10)),
  ]);

  const profile = asRecord(profileRecord);
  const personalStatusRecord = asRecord(personalStatus);
  const connectedApps = personalConnections
    .map((item) => inferConnectedApp(item))
    .filter((value): value is string => Boolean(value));

  const knownGaps: string[] = [];
  if (!profileRecord) knownGaps.push("profile.missing");
  if (!inferConfigured(personalStatusRecord)) knownGaps.push("personal.unconfigured");
  if (inferConfigured(personalStatusRecord) && connectedApps.length === 0) knownGaps.push("personal.no_connections");
  if (!worldShortlist.length) knownGaps.push("world.shortlist_empty");

  const brief: ContextBrief = {
    profileStatus: {
      exists: Boolean(profileRecord),
      displayName: typeof profile.displayName === "string" ? profile.displayName : null,
      goalsCount: profileGoals.length,
      factsCount: Object.keys(profileFacts).length,
      preferenceCount: Object.keys(profilePreferences).length,
      constraintCount: Object.keys(profileConstraints).length,
      snapshotAvailable: Boolean(profileSnapshot),
    },
    personalStatus: {
      configured: inferConfigured(personalStatusRecord),
      mode: inferMode(personalStatusRecord),
      connectedCount: connectedApps.length,
      connectedApps,
    },
    worldStatus: {
      shortlistCount: worldShortlist.length,
      incrementalWorldCount: incremental.items.world.length,
      available: worldShortlist.length > 0 || incremental.items.world.length > 0,
    },
    recentSignals: {
      pushes: recentPushes,
      feedback: recentFeedback,
      incremental: {
        world: incremental.items.world,
        personal: incremental.items.personal,
      },
      runToken: incremental.runToken,
      generatedAt: incremental.generatedAt,
      pendingCount: incremental.meta.pendingCount,
      oldestPendingAt: incremental.meta.oldestPendingAt,
    },
    knownGaps,
    candidateWorldItems: worldShortlist,
    dedupContext: {
      profile: profileRecord
        ? {
          profile,
          facts: profileFacts,
          goals: profileGoals,
          preferences: profilePreferences,
          constraints: profileConstraints,
          snapshot: profileSnapshot,
        }
        : null,
      personal: {
        status: personalStatusRecord,
        connections: personalConnections,
      },
      world: {
        shortlist: worldShortlist,
      },
      recentSignals: {
        pushes: recentPushes,
        feedback: recentFeedback,
        incremental: {
          world: incremental.items.world,
          personal: incremental.items.personal,
        },
      },
    },
  };

  emit({
    timestamp: nowIso(),
    phase: "context",
    kind: "context.summary",
    name: "Context summary",
    attrs: {
      profileExists: brief.profileStatus.exists,
      connectedApps: brief.personalStatus.connectedApps,
      shortlistCount: brief.worldStatus.shortlistCount,
      knownGaps,
    },
  });

  return brief;
}
