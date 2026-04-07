import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const MAX_STORED_RUNS = 5;

export interface StoredRun {
  id: string;
  completedAt: string;
  totalIterations: number;
  finalCards: unknown[];
  scoreMap: Record<string, unknown>;
}

interface RunStore {
  runs: StoredRun[];
}

function getRunStorePath(): string {
  const home = process.env['HOME'] ?? '/tmp';
  const dir = resolve(home, '.openclaw-proactive-ai', 'proactive-ai');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return resolve(dir, 'runs.json');
}

export function loadRunStore(): RunStore {
  try {
    const raw = readFileSync(getRunStorePath(), 'utf-8');
    return JSON.parse(raw) as RunStore;
  } catch {
    return { runs: [] };
  }
}

export function saveRun(run: StoredRun): void {
  const store = loadRunStore();
  store.runs.unshift(run);
  if (store.runs.length > MAX_STORED_RUNS) {
    store.runs = store.runs.slice(0, MAX_STORED_RUNS);
  }
  writeFileSync(getRunStorePath(), JSON.stringify(store, null, 2));
}
