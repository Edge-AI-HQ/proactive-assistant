/**
 * Tests for the scheduled generator API client.
 * Mocks global fetch + supabase auth + platform to isolate the HTTP
 * contract (path / method / body) from the network. Endpoints live under
 * /api/scheduled-generators on pinai-agents.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  deleteScheduledGenerator,
  listScheduledGenerators,
  pauseScheduledGenerator,
  resumeScheduledGenerator,
  scheduledGeneratorCreate,
  scheduledGeneratorPreview,
} from "./api";

vi.mock("./supabase", () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({
        data: { session: { access_token: "token-a" } },
      })),
      refreshSession: vi.fn(async () => ({ data: { session: null }, error: null })),
    },
  },
}));
vi.mock("./platform", () => ({
  PIN_API_BASE: "",
  pinApiRequestHeaders: (headers: Record<string, string> = {}) => headers,
}));

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("scheduledGeneratorPreview", () => {
  test("POSTs the request to /api/scheduled-generators/preview", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        previewId: "pv_1",
        parsedIntent: { frequency: "daily", localTime: "09:00", timezone: "UTC", topic: "AI" },
        confirmedBrief: { title: "AI", topic: "AI" },
        semanticSignature: "sig",
        similarTasks: [],
        conversationId: null,
      }),
    );

    const preview = await scheduledGeneratorPreview({
      originalRequest: "每天 9 点给我推 AI 新闻",
      timezone: "UTC",
      schedule: { type: "cron", frequency: "daily", localTime: "09:00" },
    });

    expect(preview.previewId).toBe("pv_1");
    expect(preview.parsedIntent.localTime).toBe("09:00");
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe("/api/scheduled-generators/preview");
    expect((call[1] as RequestInit).method).toBe("POST");
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.originalRequest).toBe("每天 9 点给我推 AI 新闻");
    expect(body.timezone).toBe("UTC");
  });
});

describe("scheduledGeneratorCreate", () => {
  test("returns the created task on 201", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(201, { task: { id: "task_x", status: "active", title: "AI" } }),
    );

    const result = await scheduledGeneratorCreate({
      previewId: "pv_1",
      semanticSignature: "sig",
      originalRequest: "x",
      timezone: "UTC",
      schedule: { type: "cron", frequency: "daily", localTime: "09:00" },
      parsedIntent: { frequency: "daily", localTime: "09:00", timezone: "UTC" },
      confirmedBrief: { topic: "AI" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.task.id).toBe("task_x");
    }
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.previewId).toBe("pv_1");
    expect(body.parsedIntent.localTime).toBe("09:00");
  });

  test("surfaces 409 requiresConfirmation as a non-thrown result", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(409, {
        requiresConfirmation: true,
        similarTasks: [{ id: "task_old", title: "AI" }],
      }),
    );

    const result = await scheduledGeneratorCreate({
      previewId: "pv_1",
      semanticSignature: "sig",
      originalRequest: "x",
      timezone: "UTC",
      schedule: { type: "interval", everySeconds: 300 },
      parsedIntent: {},
      confirmedBrief: {},
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.requiresConfirmation).toBe(true);
      expect(result.similarTasks[0]!.id).toBe("task_old");
    }
  });
});

describe("listScheduledGenerators", () => {
  test("GETs and unwraps items, default excludes archived", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { items: [{ id: "task_1", status: "active" }] }),
    );

    const items = await listScheduledGenerators();

    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe("task_1");
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/scheduled-generators");
  });

  test("includeArchived adds the query param", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [] }));

    await listScheduledGenerators(true);

    expect(fetchMock.mock.calls[0]![0]).toBe("/api/scheduled-generators?includeArchived=true");
  });
});

describe("pause / resume / delete", () => {
  test("pause POSTs to the pause subpath", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { task: { id: "task_1", status: "paused" } }),
    );

    const task = await pauseScheduledGenerator("task_1");

    expect(task.status).toBe("paused");
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/scheduled-generators/task_1/pause");
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe("POST");
  });

  test("resume POSTs to the resume subpath", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { task: { id: "task_1", status: "active" } }),
    );

    const task = await resumeScheduledGenerator("task_1");

    expect(task.status).toBe("active");
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/scheduled-generators/task_1/resume");
  });

  test("delete uses the DELETE method", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { task: { id: "task_1", status: "archived" } }),
    );

    const task = await deleteScheduledGenerator("task_1");

    expect(task.status).toBe("archived");
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/scheduled-generators/task_1");
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe("DELETE");
  });
});
