// @vitest-environment node

import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dreamingMocks = vi.hoisted(() => ({
  listDreamRuns: vi.fn(),
  getDreamRunDetail: vi.fn(),
  startDreaming: vi.fn(),
  applyDreamProfile: vi.fn(),
  applyDreamGoals: vi.fn(),
}));

vi.mock("../../dreaming/service.js", () => dreamingMocks);

import { handleDreaming } from "./dreaming.js";
import type { RouteContext } from "../types.js";

function createRequest(method: string, url: string, body?: Record<string, unknown>) {
  const payload = body ? [Buffer.from(JSON.stringify(body))] : [];
  const req = Readable.from(payload) as Readable & {
    method?: string;
    headers?: Record<string, string>;
    url?: string;
  };
  req.method = method;
  req.headers = { host: "localhost" };
  req.url = url;
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

function createContext(subpath: string, method: string, body?: Record<string, unknown>) {
  const response = createResponse();
  const ctx = {
    api: { logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } } as RouteContext["api"],
    url: new URL(`http://localhost/proactive-ai/api${subpath}`),
    req: createRequest(method, `/proactive-ai/api${subpath}`, body) as RouteContext["req"],
    res: response.res as RouteContext["res"],
    subpath,
  } satisfies RouteContext;
  return { ctx, response };
}

describe("handleDreaming", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns dream run history", async () => {
    dreamingMocks.listDreamRuns.mockReturnValue([
      { id: "dream_1", status: "completed" },
    ]);

    const { ctx, response } = createContext("/dreaming/runs", "GET");
    const handled = await handleDreaming(ctx);

    expect(handled).toBe(true);
    expect(response.statusCode).toBe(200);
    expect(response.json).toEqual({
      ok: true,
      runs: [{ id: "dream_1", status: "completed" }],
    });
  });

  it("returns dream run detail", async () => {
    dreamingMocks.getDreamRunDetail.mockReturnValue({
      run: { id: "dream_1", status: "completed" },
      detail: { candidates: [] },
    });

    const { ctx, response } = createContext("/dreaming/runs/dream_1", "GET");
    await handleDreaming(ctx);

    expect(response.statusCode).toBe(200);
    expect(response.json).toEqual({
      ok: true,
      run: { id: "dream_1", status: "completed" },
      detail: { candidates: [] },
    });
  });

  it("starts a manual dream run asynchronously", async () => {
    dreamingMocks.startDreaming.mockResolvedValue({
      id: "dream_2",
      status: "running",
    });

    const { ctx, response } = createContext("/dreaming/run", "POST");
    await handleDreaming(ctx);

    expect(response.statusCode).toBe(202);
    expect(response.json).toEqual({
      ok: true,
      runId: "dream_2",
      status: "running",
    });
  });

  it("applies a dream profile diff", async () => {
    dreamingMocks.applyDreamProfile.mockResolvedValue({
      id: "dream_3",
      appliedAt: "2026-04-09T01:00:00.000Z",
    });

    const { ctx, response } = createContext("/dreaming/runs/dream_3/apply-profile", "POST");
    await handleDreaming(ctx);

    expect(response.statusCode).toBe(200);
    expect(response.json).toEqual({
      ok: true,
      run: {
        id: "dream_3",
        appliedAt: "2026-04-09T01:00:00.000Z",
      },
    });
  });

  it("applies dream goal changes", async () => {
    dreamingMocks.applyDreamGoals.mockResolvedValue({
      id: "dream_4",
      goalsAppliedAt: "2026-04-09T02:00:00.000Z",
    });

    const { ctx, response } = createContext("/dreaming/runs/dream_4/apply-goals", "POST");
    await handleDreaming(ctx);

    expect(response.statusCode).toBe(200);
    expect(response.json).toEqual({
      ok: true,
      run: {
        id: "dream_4",
        goalsAppliedAt: "2026-04-09T02:00:00.000Z",
      },
    });
  });
});
