// @vitest-environment node

import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { recordMemoryEvent } = vi.hoisted(() => ({
  recordMemoryEvent: vi.fn(),
}));

vi.mock("../../../core/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../../core/index.js")>(
    "../../../core/index.js",
  );
  return {
    ...actual,
    memory: {
      ...actual.memory,
      recordMemoryEvent,
    },
  };
});

import { handleChat } from "./chat.js";
import type { RouteContext } from "../types.js";

function createRequest(method: string, body: Record<string, unknown>) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as Readable & {
    method?: string;
    headers?: Record<string, string>;
    url?: string;
  };
  req.method = method;
  req.headers = { host: "localhost" };
  req.url = "/proactive-ai/api/chat";
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

describe("handleChat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordMemoryEvent.mockResolvedValue({
      id: "mev_chat_1",
      profileId: "default",
      source: "chat",
      kind: "user_said",
      subjectType: "conversation",
      subjectKey: "chat",
      text: "Please help me handle this Supabase issue",
      payload: {},
      confidence: 0.95,
      occurredAt: "2026-04-10T00:00:00.000Z",
      createdAt: "2026-04-10T00:00:00.000Z",
    });
  });

  it("records direct user chat messages as memory events", async () => {
    const response = createResponse();
    const ctx = {
      api: {
        logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
        runtime: {
          subagent: {
            run: vi.fn().mockResolvedValue({ runId: "run_1" }),
            waitForRun: vi.fn().mockResolvedValue({ status: "ok" }),
            getSessionMessages: vi.fn().mockResolvedValue({
              messages: [{ role: "assistant", content: "Handled" }],
            }),
          },
        },
      } as unknown as RouteContext["api"],
      url: new URL("http://localhost/proactive-ai/api/chat"),
      req: createRequest("POST", {
        message: "Please help me handle this Supabase issue",
      }) as RouteContext["req"],
      res: response.res as RouteContext["res"],
      subpath: "/chat",
    } satisfies RouteContext;

    await handleChat(ctx);

    expect(recordMemoryEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        profileId: "default",
        source: "chat",
        kind: "user_said",
        subjectType: "conversation",
        subjectKey: "chat",
        text: "Please help me handle this Supabase issue",
      }),
    );
    expect(response.statusCode).toBe(200);
    expect(response.json).toEqual({
      ok: true,
      sessionKey: expect.any(String),
      reply: "Handled",
    });
  });
});
