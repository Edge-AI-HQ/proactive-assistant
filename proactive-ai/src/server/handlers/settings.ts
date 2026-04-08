import type { RouteContext } from "../../types/server.js";
import {
  DEFAULT_GENERATION_LANGUAGE,
  GENERATION_LANGUAGE_OPTIONS,
  isSupportedGenerationLanguage,
} from "../../types/generation-language.js";
import { json, readBody } from "../http-utils.js";
import { getGenerationLanguage, saveGenerationLanguage } from "../local-settings.js";

export async function handleSettings(ctx: RouteContext): Promise<boolean> {
  const { subpath, req, res } = ctx;
  if (subpath !== "/settings/generation-language") return false;

  if (req.method === "GET") {
    json(res, 200, {
      ok: true,
      language: getGenerationLanguage(),
      defaultLanguage: DEFAULT_GENERATION_LANGUAGE,
      options: GENERATION_LANGUAGE_OPTIONS,
    });
    return true;
  }

  if (req.method === "POST") {
    const body = await readBody(req);
    const language = body["language"];

    if (!isSupportedGenerationLanguage(language)) {
      json(res, 400, { ok: false, error: "Unsupported generation language" });
      return true;
    }

    json(res, 200, {
      ok: true,
      language: saveGenerationLanguage(language),
      defaultLanguage: DEFAULT_GENERATION_LANGUAGE,
      options: GENERATION_LANGUAGE_OPTIONS,
    });
    return true;
  }

  return false;
}
