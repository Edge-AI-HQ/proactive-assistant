import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ServerResponse } from 'node:http';

/** Load UI HTML once at module init. `pluginDir` = dirname of the plugin entry (index.ts). */
function loadUiHtml(pluginDir: string): string {
  const candidates = [
    resolve(pluginDir, 'ui', 'index.html'),
    resolve(pluginDir, 'dist', 'ui', 'index.html'),
    resolve(pluginDir, 'index.html'),
  ];
  const uiPath = candidates.find(p => existsSync(p)) ?? resolve(pluginDir, 'index.html');
  return readFileSync(uiPath, 'utf-8');
}

export function createUiHandler(pluginDir: string, gwToken: string) {
  const uiHtml = loadUiHtml(pluginDir);

  return async (_req: unknown, res: unknown) => {
    const r = res as ServerResponse;
    const html = uiHtml.replace(
      '<!-- __GW_TOKEN__ -->',
      `<script>window.__GW_TOKEN__=${JSON.stringify(gwToken)};</script>`,
    );
    r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
    r.end(html);
  };
}
