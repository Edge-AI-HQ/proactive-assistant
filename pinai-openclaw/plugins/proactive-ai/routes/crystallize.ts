/**
 * /crystallize — debug-panel control surface for the conversation
 * crystallization pipeline.
 *
 *   GET   /crystallize/state    → state + config (defaults / override / effective)
 *                                 + skill counts + 5 most recent decisions
 *   PATCH /crystallize/config   → persist a tunable subset to user_settings.metadata
 *   POST  /crystallize/run      → manually trigger one run (force=true)
 */
import type { RouteHandler } from './types.js';
import { json, readBody } from './types.js';
import * as db from '../db.js';
import {
  classifyChatSessionKind,
  runCrystallize,
  type ChatSessionKind,
} from '../conversation-crystallize/service.js';
import {
  CONVERSATION_CRYSTAL_ANALYSIS_TYPE,
  DEFAULT_CRYSTALLIZE_CONFIG,
  TUNABLE_BOUNDS,
  TUNABLE_CRYSTALLIZE_KEYS,
  type TunableCrystallizeConfig,
  type TunableCrystallizeKey,
} from '../conversation-crystallize/types.js';

const RECENT_DECISIONS_LIMIT = 5;
const RECENT_DECISIONS_SCAN = 60;
const SUMMARY_PREVIEW_CHARS = 200;

interface CrystallizeRouteDeps {
  getCrystallizeState?: typeof db.getCrystallizeState;
  getCrystallizeOverride?: typeof db.getCrystallizeOverride;
  setCrystallizeOverride?: typeof db.setCrystallizeOverride;
  listFeedback?: typeof db.listFeedback;
  listUserSkills?: typeof db.listUserSkills;
  getUserSettings?: typeof db.getUserSettings;
  runCrystallize?: typeof runCrystallize;
}

export function handleCrystallize(deps?: CrystallizeRouteDeps): RouteHandler {
  const getCrystallizeState = deps?.getCrystallizeState ?? db.getCrystallizeState;
  const getCrystallizeOverride = deps?.getCrystallizeOverride ?? db.getCrystallizeOverride;
  const setCrystallizeOverride = deps?.setCrystallizeOverride ?? db.setCrystallizeOverride;
  const listFeedback = deps?.listFeedback ?? db.listFeedback;
  const listUserSkills = deps?.listUserSkills ?? db.listUserSkills;
  const getUserSettings = deps?.getUserSettings ?? db.getUserSettings;
  const runFn = deps?.runCrystallize ?? runCrystallize;

  return async (ctx) => {
    if (ctx.subpath === '/crystallize/state' && ctx.req.method === 'GET') {
      const payload = await buildStatePayload({
        getCrystallizeState,
        getCrystallizeOverride,
        listFeedback,
        listUserSkills,
        getUserSettings,
      });
      json(ctx.res, 200, payload);
      return true;
    }

    if (ctx.subpath === '/crystallize/config' && ctx.req.method === 'PATCH') {
      let body: Record<string, unknown>;
      try {
        body = (await readBody(ctx.req)) as Record<string, unknown>;
      } catch {
        json(ctx.res, 400, { ok: false, error: 'Invalid JSON body' });
        return true;
      }
      const validated = validateConfigPatch(body);
      if ('error' in validated) {
        json(ctx.res, 400, { ok: false, error: validated.error });
        return true;
      }
      await setCrystallizeOverride(validated.patch as Record<string, number | null>);
      const payload = await buildStatePayload({
        getCrystallizeState,
        getCrystallizeOverride,
        listFeedback,
        listUserSkills,
        getUserSettings,
      });
      json(ctx.res, 200, payload);
      return true;
    }

    if (ctx.subpath === '/crystallize/run' && ctx.req.method === 'POST') {
      try {
        const result = await runFn(ctx.api, { force: true });
        json(ctx.res, 200, { ok: true, result });
      } catch (err) {
        json(ctx.res, 500, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return true;
    }

    return false;
  };
}

interface BuildPayloadArgs {
  getCrystallizeState: typeof db.getCrystallizeState;
  getCrystallizeOverride: typeof db.getCrystallizeOverride;
  listFeedback: typeof db.listFeedback;
  listUserSkills: typeof db.listUserSkills;
  getUserSettings: typeof db.getUserSettings;
}

async function buildStatePayload(args: BuildPayloadArgs) {
  const [state, overrideRaw, settings, activeSkills, allSkills, recent] = await Promise.all([
    args.getCrystallizeState(),
    args.getCrystallizeOverride(),
    args.getUserSettings(),
    args.listUserSkills({ status: 'active', limit: 500 }),
    args.listUserSkills({ limit: 500 }),
    args.listFeedback({ source: 'agent_analysis', limit: RECENT_DECISIONS_SCAN }),
  ]);

  const override = pickTunable(overrideRaw);
  const effective = { ...DEFAULT_CRYSTALLIZE_CONFIG, ...override };

  const decisions = recent
    .filter((row) => {
      const meta = row.metadata as Record<string, unknown> | null | undefined;
      return meta && meta.analysisType === CONVERSATION_CRYSTAL_ANALYSIS_TYPE;
    })
    .slice(0, RECENT_DECISIONS_LIMIT)
    .map((row) => {
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      const summary = typeof row.text === 'string' ? row.text : '';
      return {
        ts: row.created_at,
        decision: typeof meta.decision === 'string' ? meta.decision : 'discard',
        salience: typeof meta.salience === 'number' ? meta.salience : null,
        summary: summary.length > SUMMARY_PREVIEW_CHARS
          ? `${summary.slice(0, SUMMARY_PREVIEW_CHARS - 1)}…`
          : summary,
        reason: typeof meta.reason === 'string' ? meta.reason : null,
        memoryId: typeof meta.memoryId === 'string' ? meta.memoryId : null,
        skillId: typeof meta.skillId === 'string' ? meta.skillId : null,
        turnCount: typeof meta.turnCount === 'number' ? meta.turnCount : null,
      };
    });

  const lastSessionKey = state.last_session_key ?? null;
  const lastSessionKind: ChatSessionKind | null = lastSessionKey
    ? classifyChatSessionKind(lastSessionKey)
    : null;
  const secondsSinceLastBump = computeSecondsSince(state.last_message_at);

  return {
    ok: true,
    state: {
      turn_count: state.turn_count,
      last_crystallized_at: state.last_crystallized_at,
      last_session_key: state.last_session_key,
      last_message_at: state.last_message_at,
    },
    settings: {
      auto_crystallize: settings.auto_crystallize,
    },
    config: {
      defaults: pickTunable(DEFAULT_CRYSTALLIZE_CONFIG as unknown as Record<string, number>),
      override,
      effective: pickTunable(effective as unknown as Record<string, number>),
      bounds: TUNABLE_BOUNDS,
    },
    skillCounts: {
      active: activeSkills.length,
      disabled: allSkills.length - activeSkills.length,
      total: allSkills.length,
    },
    recentDecisions: decisions,
    diagnostics: {
      lastSessionKey,
      lastSessionKind,
      secondsSinceLastBump,
    },
  };
}

function computeSecondsSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  const diff = Date.now() - parsed;
  if (diff < 0) return 0;
  return Math.floor(diff / 1000);
}

function pickTunable(raw: Record<string, number | undefined>): TunableCrystallizeConfig {
  const out: TunableCrystallizeConfig = {};
  for (const key of TUNABLE_CRYSTALLIZE_KEYS) {
    const v = raw[key];
    if (typeof v === 'number' && Number.isFinite(v)) {
      (out as Record<string, number>)[key] = v;
    }
  }
  return out;
}

function validateConfigPatch(
  raw: Record<string, unknown>,
): { patch: Record<TunableCrystallizeKey, number | null> } | { error: string } {
  const patch: Partial<Record<TunableCrystallizeKey, number | null>> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!TUNABLE_CRYSTALLIZE_KEYS.includes(k as TunableCrystallizeKey)) {
      return { error: `Unknown config key: ${k}` };
    }
    const key = k as TunableCrystallizeKey;
    if (v === null) {
      patch[key] = null;
      continue;
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return { error: `${key} must be a finite number or null` };
    }
    const bounds = TUNABLE_BOUNDS[key];
    if (bounds.integer && !Number.isInteger(v)) {
      return { error: `${key} must be an integer` };
    }
    if (v < bounds.min || v > bounds.max) {
      return { error: `${key} must be in [${bounds.min}, ${bounds.max}]` };
    }
    patch[key] = v;
  }
  return { patch: patch as Record<TunableCrystallizeKey, number | null> };
}
