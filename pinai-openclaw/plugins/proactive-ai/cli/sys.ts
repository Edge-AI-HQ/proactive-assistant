import { success, failure } from './shared.js';
import { resolveApiKey } from './personal.js';

export async function handleSys(args: string[]): Promise<string> {
  const sub = args[0];

  if (!sub || sub === 'doctor') {
    // Health checks
    const checks: Array<{ name: string; status: string; message?: string }> = [];

    // Check local SQLite DB
    try {
      const home = process.env.OPENCLAW_HOME || '/app';
      const fs = await import('node:fs');
      const dbPath = `${home}/data/proactive.db`;
      const exists = fs.existsSync(dbPath);
      checks.push({ name: 'database', status: exists ? 'ok' : 'ok', message: exists ? `SQLite: ${dbPath}` : `SQLite: will be created at ${dbPath}` });
    } catch { checks.push({ name: 'database', status: 'ok', message: 'SQLite (auto-created on first use)' }); }

    // Check Composio using the same resolution path as `pin personal ...`.
    const composioKey = resolveApiKey();
    checks.push({
      name: 'composio',
      status: composioKey ? 'ok' : 'not_configured',
      message: composioKey
        ? (composioKey.source === 'user' ? 'user key file present' : 'COMPOSIO_API_KEY present')
        : 'Composio API key not configured',
    });

    // Check user ID
    const userId = process.env.PROACTIVE_USER_ID;
    checks.push({ name: 'user', status: userId ? 'ok' : 'error', message: userId ? `User: ${userId.slice(0, 8)}...` : 'PROACTIVE_USER_ID not set' });

    const allOk = checks.every(c => c.status === 'ok' || c.status === 'not_configured');
    return success('sys', 'doctor', { status: allOk ? 'healthy' : 'degraded', checks, version: '1.0.0-cloud' });
  }

  if (sub === 'schema') {
    // Command introspection
    const domains = {
      profile: ['get', 'list', 'create', 'update', 'facts', 'preferences', 'constraints', 'goals', 'memory', 'signal', 'interests', 'snapshot'],
      personal: ['status', 'setup', 'connections list', 'connect', 'wait', 'tools search', 'tools schema', 'exec'],
      world: ['search', 'headlines', 'find', 'list', 'get', 'shortlist', 'context', 'index'],
      feedback: ['log', 'list', 'get', 'stats'],
      push: ['record', 'history', 'get', 'outcome', 'find-similar'],
      cards: ['recent'],
      memory: ['help', 'list', 'get', 'add', 'archive', 'supersede', 'search'],
      signals: ['help', 'recent', 'list', 'get', 'consume'],
      raw: ['help', 'gmail recent', 'gmail thread', 'gcal today', 'gcal week', 'gcal list', 'device-apps', 'device-contacts list', 'device-contacts search'],
      evolution: ['help', 'list', 'get', 'recent', 'create', 'delta', 'refs consumed', 'refs produced', 'complete', 'fail'],
      skills: ['help', 'list', 'show', 'add', 'update', 'enable', 'disable'],
      tasks: ['help', 'list', 'show', 'attempts', 'cancel', 'enqueue'],
      sys: ['doctor', 'schema'],
    };
    return success('sys', 'schema', { domains });
  }

  return failure('sys', sub ?? 'unknown', 'not_found', `Unknown sys command: ${sub}`);
}
