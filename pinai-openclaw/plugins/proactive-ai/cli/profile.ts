import { parseArgs, success, failure } from './shared.js';
import * as db from '../db.js';

export async function handleProfile(args: string[]): Promise<string> {
  const { positional, flags } = parseArgs(args);
  const sub = positional[0];

  // Sub-domain routing for nested commands
  if (sub === 'facts') return handleFacts(positional.slice(1), flags);
  if (sub === 'preferences') return handlePreferences(positional.slice(1), flags);
  if (sub === 'constraints') return handleConstraints(positional.slice(1), flags);
  if (sub === 'goals') return handleGoals(positional.slice(1), flags);
  if (sub === 'memory') return handleMemory(positional.slice(1), flags);
  if (sub === 'signal') return handleSignal(positional.slice(1), flags);
  if (sub === 'interests') return handleInterests(positional.slice(1), flags);
  if (sub === 'snapshot') return handleSnapshot(positional.slice(1), flags);

  if (sub === 'get') {
    const profile = await db.getProfile();
    if (!profile) return failure('profile', 'get', 'not_found', 'No profile found', 'run `pin profile create --id default --display-name "Name" --json`');
    const goals = await db.listGoals();
    return success('profile', 'get', { profile, goals });
  }

  if (sub === 'list') {
    const profile = await db.getProfile();
    return success('profile', 'list', { profiles: profile ? [profile] : [] });
  }

  if (sub === 'create') {
    const displayName = flags['display-name'] ?? flags['displayName'] ?? 'User';
    const profile = await db.upsertProfile({
      displayName,
      locale: flags['locale'],
      timezone: flags['timezone'],
      summary: flags['summary'],
    });
    return success('profile', 'create', profile);
  }

  if (sub === 'update') {
    const fields: Record<string, unknown> = {};
    if (flags['display-name']) fields.display_name = flags['display-name'];
    if (flags['locale']) fields.locale = flags['locale'];
    if (flags['timezone']) fields.timezone = flags['timezone'];
    if (flags['summary']) fields.summary = flags['summary'];
    if (flags['metadata']) fields.metadata = JSON.parse(flags['metadata']);
    const profile = await db.updateProfile(fields as any);
    return success('profile', 'update', profile);
  }

  if (sub === 'delete') {
    await db.deleteProfile();
    return success('profile', 'delete', { message: 'Profile deleted' });
  }

  return failure('profile', sub ?? 'unknown', 'validation', `Unknown profile command: ${sub}`, 'Available: get, list, create, update, facts, preferences, goals, constraints, memory, signal, interests, snapshot');
}

async function handleFacts(args: string[], flags: Record<string, string>): Promise<string> {
  const action = args[0];
  if (action === 'get') {
    const data = await db.getFacts();
    return flags['key'] ? success('profile', 'facts.get', { key: flags['key'], value: data[flags['key']] ?? null }) : success('profile', 'facts.get', data);
  }
  if (action === 'set') {
    if (!flags['key']) return failure('profile', 'facts.set', 'validation', 'Missing --key');
    const value = flags['value-json'] ? JSON.parse(flags['value-json']) : flags['value'] ?? null;
    const data = await db.setFact(flags['key'], value);
    return success('profile', 'facts.set', data);
  }
  if (action === 'unset') {
    if (!flags['key']) return failure('profile', 'facts.unset', 'validation', 'Missing --key');
    const data = await db.unsetFact(flags['key']);
    return success('profile', 'facts.unset', data);
  }
  return failure('profile', 'facts', 'validation', `Unknown facts action: ${action}`);
}

async function handlePreferences(args: string[], flags: Record<string, string>): Promise<string> {
  const action = args[0];
  if (action === 'get') {
    const data = await db.getPreferences();
    return flags['key'] ? success('profile', 'preferences.get', { key: flags['key'], value: data[flags['key']] ?? null }) : success('profile', 'preferences.get', data);
  }
  if (action === 'set') {
    if (!flags['key']) return failure('profile', 'preferences.set', 'validation', 'Missing --key');
    const value = flags['value-json'] ? JSON.parse(flags['value-json']) : flags['value'] ?? null;
    const data = await db.setPreference(flags['key'], value);
    return success('profile', 'preferences.set', data);
  }
  if (action === 'unset') {
    if (!flags['key']) return failure('profile', 'preferences.unset', 'validation', 'Missing --key');
    const data = await db.unsetPreference(flags['key']);
    return success('profile', 'preferences.unset', data);
  }
  return failure('profile', 'preferences', 'validation', `Unknown preferences action: ${action}`);
}

async function handleConstraints(args: string[], flags: Record<string, string>): Promise<string> {
  const action = args[0];
  if (action === 'get') {
    const data = await db.getConstraints();
    return flags['key'] ? success('profile', 'constraints.get', { key: flags['key'], value: data[flags['key']] ?? null }) : success('profile', 'constraints.get', data);
  }
  if (action === 'set') {
    if (!flags['key']) return failure('profile', 'constraints.set', 'validation', 'Missing --key');
    const value = flags['value-json'] ? JSON.parse(flags['value-json']) : flags['value'] ?? null;
    const data = await db.setConstraint(flags['key'], value);
    return success('profile', 'constraints.set', data);
  }
  if (action === 'unset') {
    if (!flags['key']) return failure('profile', 'constraints.unset', 'validation', 'Missing --key');
    const data = await db.unsetConstraint(flags['key']);
    return success('profile', 'constraints.unset', data);
  }
  return failure('profile', 'constraints', 'validation', `Unknown constraints action: ${action}`);
}

async function handleGoals(args: string[], flags: Record<string, string>): Promise<string> {
  const action = args[0];
  if (action === 'list') {
    const goals = await db.listGoals();
    return success('profile', 'goals.list', { goals });
  }
  if (action === 'upsert') {
    if (!flags['key'] || !flags['title']) return failure('profile', 'goals.upsert', 'validation', 'Missing --key or --title');
    const goal = await db.upsertGoal({ key: flags['key'], title: flags['title'], priority: flags['priority'] });
    return success('profile', 'goals.upsert', goal);
  }
  if (action === 'close') {
    if (!flags['key']) return failure('profile', 'goals.close', 'validation', 'Missing --key');
    const goal = await db.closeGoal(flags['key']);
    return success('profile', 'goals.close', goal);
  }
  return failure('profile', 'goals', 'validation', `Unknown goals action: ${action}`);
}

async function handleMemory(args: string[], flags: Record<string, string>): Promise<string> {
  const action = args[0];
  if (action === 'list') {
    const memories = await db.listMemories({ limit: flags['limit'] ? parseInt(flags['limit'], 10) : undefined });
    return success('profile', 'memory.list', { memories });
  }
  if (action === 'add') {
    if (!flags['kind'] || !flags['text']) return failure('profile', 'memory.add', 'validation', 'Missing --kind or --text');
    const tags = flags['tags-json'] ? JSON.parse(flags['tags-json']) : [];
    const memory = await db.addMemory({ kind: flags['kind'], text: flags['text'], tags });
    return success('profile', 'memory.add', memory);
  }
  if (action === 'search') {
    if (!flags['query']) return failure('profile', 'memory.search', 'validation', 'Missing --query');
    const memories = await db.searchMemory(flags['query'], { limit: flags['limit'] ? parseInt(flags['limit'], 10) : undefined });
    return success('profile', 'memory.search', { query: flags['query'], memories });
  }
  if (action === 'remove') {
    if (!flags['id']) return failure('profile', 'memory.remove', 'validation', 'Missing --id');
    await db.removeMemory(flags['id']);
    return success('profile', 'memory.remove', { removed: flags['id'] });
  }
  return failure('profile', 'memory', 'validation', `Unknown memory action: ${action}`);
}

async function handleSignal(args: string[], flags: Record<string, string>): Promise<string> {
  const action = args[0];
  if (action === 'add') {
    if (!flags['kind'] || !flags['target-type'] || !flags['target-key']) {
      return failure('profile', 'signal.add', 'validation', 'Missing --kind, --target-type, or --target-key');
    }
    const signal = await db.addSignal({
      kind: flags['kind'],
      targetType: flags['target-type'],
      targetKey: flags['target-key'],
      value: flags['value'] ? parseFloat(flags['value']) : undefined,
      source: flags['source'],
    });
    return success('profile', 'signal.add', signal);
  }
  if (action === 'rollup') {
    const since = flags['since'] ? parseInt(flags['since'].replace('d', ''), 10) : 30;
    const interests = await db.rollupSignals(since);
    return success('profile', 'signal.rollup', { count: interests.length, interests });
  }
  return failure('profile', 'signal', 'validation', `Unknown signal action: ${action}`);
}

async function handleInterests(args: string[], flags: Record<string, string>): Promise<string> {
  const action = args[0];
  if (action === 'list') {
    const interests = await db.listInterests({
      kind: flags['kind'],
      limit: flags['limit'] ? parseInt(flags['limit'], 10) : 20,
    });
    return success('profile', 'interests.list', { interests });
  }
  return failure('profile', 'interests', 'validation', `Unknown interests action: ${action}`);
}

async function handleSnapshot(_args: string[], _flags: Record<string, string>): Promise<string> {
  // Snapshot build: gather full profile state
  const [profile, goals, memories, signals, interests] = await Promise.all([
    db.getProfile(), db.listGoals(), db.listMemories(), db.listSignals({ limit: 100 }), db.listInterests(),
  ]);
  return success('profile', 'snapshot.build', { profile, goals, memories, signals, interests });
}
