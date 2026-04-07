import type { IncomingMessage, ServerResponse } from 'node:http';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';

export interface RouteContext {
  api: OpenClawPluginApi;
  url: URL;
  req: IncomingMessage;
  res: ServerResponse;
  subpath: string;
}

/** Returns true if the request was handled, false to fall through to next handler. */
export type RouteHandler = (ctx: RouteContext) => Promise<boolean>;
