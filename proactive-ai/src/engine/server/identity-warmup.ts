/**
 * Pre-warm the Composio account identity cache on gateway startup.
 *
 * Calls `listConnections` (which internally triggers `discoverConnections`)
 * so that identity tool execution results are cached in local-settings.json
 * before the user opens the CONTROL tab.
 */

import { personal as corePersonal } from '../../core/index.js';
import { buildDefaultCtx } from '../pipeline/data-access.js';

interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  debug(msg: string): void;
}

export async function warmIdentityCache(logger: Logger): Promise<void> {
  const ctx = buildDefaultCtx();
  try {
    const connections = await corePersonal.listConnections(ctx);
    const withIdentity = connections.filter(c => c.userInfo && Object.keys(c.userInfo).length > 0);
    logger.info(`Identity cache warmed: ${withIdentity.length}/${connections.length} accounts resolved`);
  } catch (err) {
    logger.debug(`Identity cache warmup skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}
