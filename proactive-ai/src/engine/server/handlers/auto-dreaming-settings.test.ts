// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const settingsFns = vi.hoisted(() => ({
  getAutoDreaming: vi.fn(),
  saveAutoDreaming: vi.fn(),
}));

const dataAccessFns = vi.hoisted(() => ({
  getDefaultProfile: vi.fn(),
}));

vi.mock("../local-settings.js", async () => {
  const actual = await vi.importActual<typeof import("../local-settings.js")>("../local-settings.js");
  return {
    ...actual,
    getAutoDreaming: settingsFns.getAutoDreaming,
    saveAutoDreaming: settingsFns.saveAutoDreaming,
  };
});

vi.mock("../../pipeline/data-access.js", () => ({
  getDefaultProfile: dataAccessFns.getDefaultProfile,
}));

import { Readable } from "node:stream";
import { handleAutoDreamingSettings } from "./settings.js";
import type { RouteContext } from "../types.js";

function createRequest(method: string, body?: Record<string, unknown>) {
  const payload = body ? [Buffer.from(JSON.stringify(body))] : [];
  const req = Readable.from(payload) as Readable & {
    method?: string;
    headers?: Record<string, string>;
    url?: string;
  };
  req.method = method;
  req.headers = { host: "localhost" };
  req.url = "/proactive-ai/api/settings/auto-dreaming";
  return req;
}

function createResponse() {
  let statusCode = 0;
  let payload = "";
  return {
    res: {
      writeHead(code: number) {
        statusCode = code;
      },
      end(body: string) {
        payload = body;
      },
    },
    get statusCode() {
      return statusCode;
    },
    get json() {
      return payload ? JSON.parse(payload) : null;
    },
  };
}

function createContext(method: string, body?: Record<string, unknown>) {
  const response = createResponse();
  const ctx = {
    api: {} as RouteContext["api"],
    url: new URL("http://localhost/proactive-ai/api/settings/auto-dreaming"),
    req: createRequest(method, body) as RouteContext["req"],
    res: response.res as RouteContext["res"],
    subpath: "/settings/auto-dreaming",
  } satisfies RouteContext;
  return { ctx, response };
}

describe("handleAutoDreamingSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dataAccessFns.getDefaultProfile.mockResolvedValue(null);
  });

  it("returns the saved auto dreaming setting using the effective profile timezone", async () => {
    settingsFns.getAutoDreaming.mockReturnValue(true);
    dataAccessFns.getDefaultProfile.mockResolvedValue({ timezone: "Asia/Shanghai" });

    const { ctx, response } = createContext("GET");
    await handleAutoDreamingSettings(ctx);

    expect(response.statusCode).toBe(200);
    expect(response.json).toEqual({
      ok: true,
      enabled: true,
      schedule: {
        type: "daily",
        hour: 6,
        minute: 0,
        timezone: "Asia/Shanghai",
      },
    });
  });

  it("persists the posted toggle", async () => {
    settingsFns.saveAutoDreaming.mockReturnValue(true);

    const { ctx, response } = createContext("POST", { enabled: true });
    await handleAutoDreamingSettings(ctx);

    expect(settingsFns.saveAutoDreaming).toHaveBeenCalledWith(true);
    expect(response.statusCode).toBe(200);
    expect(response.json).toEqual({
      ok: true,
      enabled: true,
      schedule: {
        type: "daily",
        hour: 6,
        minute: 0,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    });
  });
});
