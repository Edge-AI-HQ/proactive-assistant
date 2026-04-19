import * as mobileDb from "../mobile-db.js";
import type { RouteHandler } from "./types.js";
import { json, readBody } from "./types.js";

export function handleMobile(): RouteHandler {
  return async (ctx) => {
    if (ctx.subpath === "/mobile/items/ingest" && ctx.req.method === "POST") {
      const body = await readBody(ctx.req);
      const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : "";
      const items = Array.isArray(body.items) ? body.items : [];
      if (!deviceId) {
        json(ctx.res, 400, { ok: false, error: "deviceId is required" });
        return true;
      }
      const result = mobileDb.ingestMobileItems({
        deviceId,
        items: items.map((item) => ({
          id: typeof item?.id === "string" ? item.id : "",
          itemType: typeof item?.itemType === "string" ? item.itemType : "",
          title: typeof item?.title === "string" ? item.title : "",
          summary: typeof item?.summary === "string" ? item.summary : "",
          payload: typeof item?.payload === "object" && item.payload !== null ? item.payload as Record<string, unknown> : {},
          salience: typeof item?.salience === "number" ? item.salience : 0,
          confidence: typeof item?.confidence === "number" ? item.confidence : 0,
          dedupeKey: typeof item?.dedupeKey === "string" ? item.dedupeKey : undefined,
          occurredAt: typeof item?.occurredAt === "string" || typeof item?.occurredAt === "number" ? item.occurredAt : undefined,
          availableAt: typeof item?.availableAt === "string" || typeof item?.availableAt === "number" ? item.availableAt : undefined,
          expiresAt: typeof item?.expiresAt === "string" || typeof item?.expiresAt === "number" ? item.expiresAt : undefined,
        })).filter((item) => item.id && item.itemType && item.title && item.summary),
      });
      json(ctx.res, 200, { ok: true, ...result });
      return true;
    }

    if (ctx.subpath === "/mobile/items" && ctx.req.method === "GET") {
      const limit = Number.parseInt(ctx.url.searchParams.get("limit") ?? "50", 10);
      const items = mobileDb.listMobileItems({
        status: ctx.url.searchParams.get("status") ?? undefined,
        itemType: ctx.url.searchParams.get("type") ?? undefined,
        since: ctx.url.searchParams.get("since") ?? undefined,
        until: ctx.url.searchParams.get("until") ?? undefined,
        deviceId: ctx.url.searchParams.get("deviceId") ?? undefined,
        limit: Number.isFinite(limit) ? limit : 50,
      });
      json(ctx.res, 200, { ok: true, items });
      return true;
    }

    if (ctx.subpath === "/mobile/items/claim" && ctx.req.method === "POST") {
      const body = await readBody(ctx.req);
      const limit = typeof body.limit === "number" ? body.limit : Number.parseInt(String(body.limit ?? "20"), 10);
      const result = mobileDb.claimMobileItems({
        itemType: typeof body.type === "string" ? body.type : undefined,
        since: typeof body.since === "string" ? body.since : undefined,
        until: typeof body.until === "string" ? body.until : undefined,
        deviceId: typeof body.deviceId === "string" ? body.deviceId : undefined,
        limit: Number.isFinite(limit) ? limit : 20,
      });
      json(ctx.res, 200, { ok: true, runToken: result.runToken, items: result.items });
      return true;
    }

    if (ctx.subpath === "/mobile/items/commit" && ctx.req.method === "POST") {
      const body = await readBody(ctx.req);
      const runToken = typeof body.runToken === "string" ? body.runToken.trim() : "";
      if (!runToken) {
        json(ctx.res, 400, { ok: false, error: "runToken is required" });
        return true;
      }
      const result = mobileDb.commitMobileItemRun(runToken);
      json(ctx.res, 200, { ok: true, runToken, processed: result.processed });
      return true;
    }

    return false;
  };
}
