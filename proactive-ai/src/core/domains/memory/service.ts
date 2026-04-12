import { PinDatabaseManager } from "../../db/database.js";
import { resolveAppRootFromCtx } from "../../paths.js";
import type { CoreContext } from "../../context.js";
import { ProfileRepository } from "../profile/repository.js";
import type { ProfileRecord } from "../profile/schema.js";
import type { MemoryEntryRecord, MemoryEventRecord } from "./schema.js";
import { MemoryRepository, type RecordMemoryEventInput, type MemoryRepository as MemoryRepositoryType } from "./repository.js";

export interface ConsolidateMemoryEventsInput {
  profileId: string;
  memoryRepository: MemoryRepositoryType;
}

export interface ConsolidateMemoryEventsResult {
  entriesUpdated: number;
}

export interface BuildMemoryContextPackInput {
  profileId: string;
  queryText?: string;
  residentLimit?: number;
  relevantLimit?: number;
  recentEventLimit?: number;
  memoryRepository: MemoryRepositoryType;
  profileRepository: ProfileRepository;
}

export interface MemoryContextPack {
  profile: {
    id: string;
    displayName: string;
    summary: string | null;
    timezone: string | null;
    goals: Array<Record<string, unknown>>;
    preferences: Record<string, unknown>;
    constraints: Record<string, unknown>;
    interests: Array<Record<string, unknown>>;
  };
  residentMemories: MemoryEntryRecord[];
  relevantMemories: MemoryEntryRecord[];
  recentEvents: MemoryEventRecord[];
}

const createMemoryRepository = async (ctx: CoreContext): Promise<MemoryRepository> => {
  const dataRoot = resolveAppRootFromCtx(ctx);
  const manager = new PinDatabaseManager(dataRoot);
  await manager.init();
  return new MemoryRepository(manager.open("pin"));
};

const createProfileRepository = async (ctx: CoreContext): Promise<ProfileRepository> => {
  const dataRoot = resolveAppRootFromCtx(ctx);
  const manager = new PinDatabaseManager(dataRoot);
  await manager.init();
  return new ProfileRepository(manager.open("pin"));
};

const normalize = (value: string): string =>
  value.trim().toLowerCase();

const extractProfileView = (profile: ProfileRecord) => ({
  id: profile.id,
  displayName: profile.displayName,
  summary: profile.summary ?? null,
  timezone: profile.timezone ?? null,
  goals: ((profile.goals ?? []) as Array<Record<string, unknown>>),
  preferences: (profile.preferences ?? {}) as Record<string, unknown>,
  constraints: (profile.constraints ?? {}) as Record<string, unknown>,
  interests: ((profile.interests ?? []) as Array<Record<string, unknown>>),
});

const scoreEntryForQuery = (
  entry: MemoryEntryRecord,
  queryText: string,
  interests: Array<Record<string, unknown>>,
): number => {
  const normalizedQuery = normalize(queryText);
  const subjectKey =
    typeof entry.metadata?.subjectKey === "string"
      ? entry.metadata.subjectKey
      : "";
  const haystack = normalize(
    [entry.text, entry.category, subjectKey, JSON.stringify(entry.metadata ?? {})].join(" "),
  );

  let score = entry.score;
  if (haystack.includes(normalizedQuery)) {
    score += 3;
  }

  for (const token of normalizedQuery.split(/\s+/).filter(Boolean)) {
    if (haystack.includes(token)) {
      score += 0.75;
    }
  }

  const matchingInterest = interests.find(
    (interest) =>
      interest &&
      typeof interest === "object" &&
      interest["kind"] === "topic" &&
      typeof interest["key"] === "string" &&
      haystack.includes(normalize(interest["key"])),
  );

  if (matchingInterest && typeof matchingInterest["score"] === "number") {
    score += Number(matchingInterest["score"]);
  }

  return score;
};

const scoreEventForQuery = (
  event: MemoryEventRecord,
  queryText: string,
  interests: Array<Record<string, unknown>>,
): number => {
  const normalizedQuery = normalize(queryText);
  const haystack = normalize(
    [event.text, event.subjectType, event.subjectKey, event.kind, event.source].join(" "),
  );

  let score = event.confidence;
  if (haystack.includes(normalizedQuery)) {
    score += 3;
  }

  for (const token of normalizedQuery.split(/\s+/).filter(Boolean)) {
    if (haystack.includes(token)) {
      score += 0.75;
    }
  }

  const matchingInterest = interests.find(
    (interest) =>
      interest &&
      typeof interest === "object" &&
      interest["kind"] === "topic" &&
      typeof interest["key"] === "string" &&
      haystack.includes(normalize(interest["key"])),
  );

  if (matchingInterest && typeof matchingInterest["score"] === "number") {
    score += Number(matchingInterest["score"]);
  }

  score += new Date(event.occurredAt).getTime() / 1e15;
  return score;
};

export const consolidateMemoryEvents = async (
  input: ConsolidateMemoryEventsInput,
): Promise<ConsolidateMemoryEventsResult> => {
  const events = await input.memoryRepository.listEvents(input.profileId, {
    limit: 500,
  });

  const grouped = new Map<string, MemoryEventRecord[]>();
  for (const event of events) {
    const key = `${event.subjectType}:${event.subjectKey}`;
    const current = grouped.get(key) ?? [];
    current.push(event);
    grouped.set(key, current);
  }

  let entriesUpdated = 0;
  for (const [groupKey, groupEvents] of grouped.entries()) {
    const latest = [...groupEvents].sort((left, right) =>
      right.occurredAt.localeCompare(left.occurredAt),
    )[0];

    if (!latest) {
      continue;
    }

    const separatorIndex = groupKey.indexOf(":");
    const subjectType = separatorIndex >= 0 ? groupKey.slice(0, separatorIndex) : groupKey;
    const subjectKey = separatorIndex >= 0 ? groupKey.slice(separatorIndex + 1) : "";
    const confidenceAverage =
      groupEvents.reduce((sum, event) => sum + event.confidence, 0) /
      groupEvents.length;

    await input.memoryRepository.upsertEntry({
      profileId: input.profileId,
      category: subjectType,
      text: latest.text,
      sourceEventIds: groupEvents.map((event) => event.id),
      evidenceCount: groupEvents.length,
      score: Number((confidenceAverage + groupEvents.length * 0.2).toFixed(4)),
      metadata: {
        subjectType,
        subjectKey,
        sourceKinds: Array.from(new Set(groupEvents.map((event) => event.kind))),
      },
      lastConfirmedAt: latest.occurredAt,
    });
    entriesUpdated += 1;
  }

  return { entriesUpdated };
};

export const buildMemoryContextPack = async (
  input: BuildMemoryContextPackInput,
): Promise<MemoryContextPack> => {
  const profile = await input.profileRepository.getById(input.profileId);
  if (!profile) {
    throw new Error(`Profile ${input.profileId} not found`);
  }

  const interests = ((profile.interests ?? []) as Array<Record<string, unknown>>);
  const residentMemories = await input.memoryRepository.listEntries(input.profileId, {
    limit: input.residentLimit ?? 6,
    status: "active",
  });

  if (!input.queryText?.trim()) {
    return {
      profile: extractProfileView(profile),
      residentMemories,
      relevantMemories: [],
      recentEvents: [],
    };
  }

  const allEntries = await input.memoryRepository.listEntries(input.profileId, {
    limit: 100,
  });
  const allEvents = await input.memoryRepository.listEvents(input.profileId, {
    limit: 100,
  });

  const relevantMemories = [...allEntries]
    .map((entry) => ({
      entry,
      score: scoreEntryForQuery(entry, input.queryText ?? "", interests),
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, input.relevantLimit ?? 5)
    .map(({ entry }) => entry);

  const recentEvents = [...allEvents]
    .map((event) => ({
      event,
      score: scoreEventForQuery(event, input.queryText ?? "", interests),
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, input.recentEventLimit ?? 5)
    .map(({ event }) => event);

  return {
    profile: extractProfileView(profile),
    residentMemories,
    relevantMemories,
    recentEvents,
  };
};

export const recordMemoryEvent = async (
  ctx: CoreContext,
  input: RecordMemoryEventInput,
): Promise<MemoryEventRecord> => {
  const repository = await createMemoryRepository(ctx);
  return repository.recordEvent(input);
};

export const listMemoryEntries = async (
  ctx: CoreContext,
  input: { profileId: string; limit?: number; status?: string; category?: string },
): Promise<MemoryEntryRecord[]> => {
  const repository = await createMemoryRepository(ctx);
  return repository.listEntries(input.profileId, input);
};

export const searchMemoryEvents = async (
  ctx: CoreContext,
  input: {
    profileId: string;
    query: string;
    limit?: number;
    subjectType?: string;
    subjectKey?: string;
  },
): Promise<MemoryEventRecord[]> => {
  const repository = await createMemoryRepository(ctx);
  return repository.searchEvents(input.profileId, input);
};

export const buildMemoryContext = async (
  ctx: CoreContext,
  input: {
    profileId: string;
    queryText?: string;
    residentLimit?: number;
    relevantLimit?: number;
    recentEventLimit?: number;
  },
): Promise<MemoryContextPack> => {
  const [memoryRepository, profileRepository] = await Promise.all([
    createMemoryRepository(ctx),
    createProfileRepository(ctx),
  ]);

  return buildMemoryContextPack({
    ...input,
    memoryRepository,
    profileRepository,
  });
};
