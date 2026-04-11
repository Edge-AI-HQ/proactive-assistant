// @vitest-environment node

import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { logFeedback, recordMemoryEvent } = vi.hoisted(() => ({
  logFeedback: vi.fn(),
  recordMemoryEvent: vi.fn(),
}));

vi.mock("../../../core/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../../core/index.js")>("../../../core/index.js");
  return {
    ...actual,
    feedback: {
      ...actual.feedback,
      logFeedback,
    },
    memory: {
      ...actual.memory,
      recordMemoryEvent,
    },
  };
});

import { handleFeedback } from "./feedback.js";
import type { RouteContext } from '../types.js';
import { ValidationError } from "../../../core/index.js";

function createRequest(method: string, body: Record<string, unknown>) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as Readable & {
    method?: string;
    headers?: Record<string, string>;
    url?: string;
  };
  req.method = method;
  req.headers = { host: "localhost" };
  req.url = "/proactive-ai/api/feedback";
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

function createContext(method: string, body: Record<string, unknown>) {
  const response = createResponse();
  const ctx = {
    api: {} as RouteContext["api"],
    url: new URL("http://localhost/proactive-ai/api/feedback"),
    req: createRequest(method, body) as RouteContext["req"],
    res: response.res as RouteContext["res"],
    subpath: "/feedback",
  } satisfies RouteContext;

  return { ctx, response };
}

describe("handleFeedback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordMemoryEvent.mockResolvedValue({
      id: "mev_123",
      profileId: "default",
      source: "feedback",
      kind: "user_confirmed",
      subjectType: "intent",
      subjectKey: "work:review-queue-with-alex",
      text: "Ship it",
      payload: {},
      confidence: 1,
      occurredAt: "2026-04-07T10:00:00.000Z",
      createdAt: "2026-04-07T10:00:00.000Z",
    });
  });

  it("returns 400 when kind is missing", async () => {
    const { ctx, response } = createContext("POST", {});

    const handled = await handleFeedback(ctx);

    expect(handled).toBe(true);
    expect(response.statusCode).toBe(400);
    expect(response.json).toEqual({ error: "Missing kind" });
    expect(logFeedback).not.toHaveBeenCalled();
  });

  it("passes through the full feedback payload to core feedback service", async () => {
    logFeedback.mockResolvedValue({
      id: "fe_123",
      kind: "card_action",
      action: "confirm",
      pushId: "push_123",
      intentCardId: "card_1_1",
      conversationId: "conv_1",
      messageId: "msg_1",
      source: "user_direct",
      basket: "work",
      channel: "web",
      value: "accepted",
      text: "Ship it",
      metadata: {
        runId: "run_123",
        intentKey: "work:review-queue-with-alex",
        surface: "now_feed",
      },
      createdAt: "2026-04-07T10:00:00.000Z",
    });

    const { ctx, response } = createContext("POST", {
      kind: "card_action",
      action: "confirm",
      pushId: "push_123",
      intentCardId: "card_1_1",
      conversationId: "conv_1",
      messageId: "msg_1",
      basket: "work",
      channel: "web",
      value: "accepted",
      text: "Ship it",
      at: "2026-04-07T10:00:00.000Z",
      metadata: {
        runId: "run_123",
        intentKey: "work:review-queue-with-alex",
        surface: "now_feed",
      },
    });

    await handleFeedback(ctx);

    expect(logFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        env: process.env,
      }),
      {
        kind: "card_action",
        action: "confirm",
        pushId: "push_123",
        intentCardId: "card_1_1",
        conversationId: "conv_1",
        messageId: "msg_1",
        source: "user_direct",
        basket: "work",
        channel: "web",
        value: "accepted",
        text: "Ship it",
        at: "2026-04-07T10:00:00.000Z",
        metadata: {
          runId: "run_123",
          intentKey: "work:review-queue-with-alex",
          surface: "now_feed",
        },
      },
    );
    expect(response.statusCode).toBe(200);
    expect(response.json).toEqual({
      ok: true,
      data: {
        id: "fe_123",
        kind: "card_action",
        action: "confirm",
        pushId: "push_123",
        intentCardId: "card_1_1",
        conversationId: "conv_1",
        messageId: "msg_1",
        source: "user_direct",
        basket: "work",
        channel: "web",
        value: "accepted",
        text: "Ship it",
        metadata: {
          runId: "run_123",
          intentKey: "work:review-queue-with-alex",
          surface: "now_feed",
        },
        createdAt: "2026-04-07T10:00:00.000Z",
      },
    });
    expect(recordMemoryEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        profileId: "default",
        source: "feedback",
        kind: "user_confirmed",
        subjectType: "intent",
        subjectKey: "work:review-queue-with-alex",
        text: "Ship it",
      }),
    );
  });

  it("uses user_direct as the default source", async () => {
    logFeedback.mockResolvedValue({
      id: "fe_456",
      kind: "dismiss",
      intentCardId: "card_2_1",
      source: "user_direct",
      metadata: {},
      createdAt: "2026-04-07T11:00:00.000Z",
    });

    const { ctx } = createContext("POST", {
      kind: "dismiss",
      intentCardId: "card_2_1",
    });

    await handleFeedback(ctx);

    expect(logFeedback).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        kind: "dismiss",
        intentCardId: "card_2_1",
        source: "user_direct",
      }),
    );
  });

  it("maps core validation errors to 400 responses", async () => {
    logFeedback.mockRejectedValue(
      new ValidationError(
        "INVALID_ARGUMENT",
        "Invalid --kind",
        "check `pin feedback log --help`",
      ),
    );

    const { ctx, response } = createContext("POST", {
      kind: "invalid_kind",
    });

    await handleFeedback(ctx);

    expect(response.statusCode).toBe(400);
    expect(response.json).toEqual({
      ok: false,
      error: {
        type: "validation",
        code: "INVALID_ARGUMENT",
        message: "Invalid --kind",
        hint: "check `pin feedback log --help`",
      },
    });
  });
});
