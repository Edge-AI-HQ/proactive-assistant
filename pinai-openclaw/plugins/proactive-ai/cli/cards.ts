import * as db from '../db.js';
import { parseArgs, success, failure } from './shared.js';

interface CardsCliDeps {
  listRecentGeneratedCards?: typeof db.listRecentGeneratedCards;
}

export async function handleCards(args: string[], deps?: CardsCliDeps): Promise<string> {
  const { positional, flags } = parseArgs(args);
  const sub = positional[0];
  const listRecentGeneratedCards = deps?.listRecentGeneratedCards ?? db.listRecentGeneratedCards;

  if (sub === 'recent') {
    const records = await listRecentGeneratedCards({
      limit: flags['limit'] ? parseInt(flags['limit'], 10) : undefined,
      basket: flags['basket'],
      since: flags['since'],
    });
    return success('cards', 'recent', { count: records.length, records });
  }

  return failure('cards', sub ?? 'unknown', 'validation', `Unknown cards command: ${sub}`, 'Available: recent');
}
