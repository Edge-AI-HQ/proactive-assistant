import { existsSync, createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const MIME_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json',
};

export function createAssetsHandler(pluginDir: string) {
  const searchDirs = [
    resolve(pluginDir, 'public'),
    resolve(pluginDir, '..', 'public'),
    resolve(pluginDir, 'ui'),
  ];

  return async (req: unknown, res: unknown) => {
    const r = res as ServerResponse;
    const rq = req as IncomingMessage;
    const url = new URL(rq.url ?? '/', `http://${rq.headers.host ?? 'localhost'}`);
    const assetName = url.pathname.replace(/^\/proactive-ai\/assets\/?/, '');

    if (!assetName || assetName.includes('..')) {
      r.writeHead(404); r.end(); return;
    }

    const filePath = searchDirs
      .map(dir => resolve(dir, assetName))
      .find(p => existsSync(p));

    if (!filePath) {
      r.writeHead(404); r.end(); return;
    }

    const ext = '.' + assetName.split('.').pop();
    r.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream',
      'Cache-Control': 'public, max-age=86400',
    });
    createReadStream(filePath).pipe(r);
  };
}
