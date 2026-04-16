import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { RouteContext } from "./types.js";
import { json } from "./http-utils.js";
import { gatewayOriginState } from "../state.js";
import { handleHealth } from "./handlers/health.js";
import { handleGenerate } from "./handlers/generate.js";
import { handleRuns } from "./handlers/runs.js";
import { handleChat } from "./handlers/chat.js";
import { handleFeedback } from "./handlers/feedback.js";
import { handleComposio } from "./handlers/composio.js";
import { handleProfile } from "./handlers/profile.js";
import { handleProfileIngest } from "./handlers/profile-ingest.js";
import {
  handleSettings,
  handleAutoDreamingSettings,
  handleAutoGenerateSettings,
} from "./handlers/settings.js";
import { handleDreaming } from "./handlers/dreaming.js";
import { handleAutoRun } from "./handlers/auto-run.js";

const handlers = [
  handleHealth,
  handleGenerate,
  handleRuns,
  handleChat,
  handleFeedback,
  handleComposio,
  handleProfile,
  handleProfileIngest,
  handleSettings,
  handleAutoDreamingSettings,
  handleAutoGenerateSettings,
  handleDreaming,
  handleAutoRun,
];

export function createApiHandler(api: OpenClawPluginApi) {
  return async (req: unknown, res: unknown) => {
    const rq = req as IncomingMessage;
    const r = res as ServerResponse;
    const url = new URL(
      rq.url ?? "/",
      `http://${rq.headers.host ?? "localhost"}`,
    );
    gatewayOriginState.gatewayOrigin = url.origin;
    const subpath = url.pathname.replace(
      /^\/proactive-ai\/(?:api|rpc)\/?/,
      "/",
    );

    const ctx: RouteContext = { api, url, req: rq, res: r, subpath };

    for (const handler of handlers) {
      if (await handler(ctx)) return;
    }

    json(r, 404, { error: "Not found" });
  };
}
