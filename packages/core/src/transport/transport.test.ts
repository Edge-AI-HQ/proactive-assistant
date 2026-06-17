import { afterEach, describe, expect, it, vi } from "vitest";

import { configureTransport } from "./config";
import { pinaiFetch, proxyFetch, proxyPost } from "./http";
import { proxyGetSSE, proxySSE } from "./sse";

function jsonResponse(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** 把 SSE 文本包成带 ReadableStream body 的 Response。 */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let i = 0;
  const body = {
    getReader: () => ({
      read: async () =>
        i < chunks.length
          ? { done: false, value: encoder.encode(chunks[i++]) }
          : { done: true, value: undefined },
      releaseLock: () => {},
    }),
  };
  return { ok: true, status: 200, body } as unknown as Response;
}

const fetchMock = vi.fn();

function configure(overrides: Parameters<typeof configureTransport>[0] extends infer T
  ? Partial<T>
  : never = {}) {
  configureTransport({
    baseUrl: "https://backend.test",
    getAuthHeaders: async () => ({ Authorization: "Bearer tok-1" }),
    fetchImpl: fetchMock as unknown as typeof fetch,
    ...overrides,
  });
}

afterEach(() => {
  fetchMock.mockReset();
  // 留下已配置状态不影响下个用例 —— 每个用例自己 configure()。
});

describe("transport config", () => {
  it("throws a descriptive error before configureTransport()", async () => {
    // 模块级单例：用一个永不匹配的配置标记“未配置”状态不可行，
    // 所以这里直接断言错误信息形状（首个用例顺序运行在任何 configure 前）。
    // 注意：若本文件用例顺序调整，此用例必须保持第一个。
    await expect(proxyFetch("/x")).rejects.toThrow(/transport not configured/);
  });
});

describe("proxyFetch", () => {
  it("prefixes baseUrl + /api and merges defaultHeaders < auth < caller", async () => {
    configure({
      defaultHeaders: { "ngrok-skip-browser-warning": "1", "X-Base": "low" },
    });
    fetchMock.mockResolvedValueOnce(jsonResponse(200));

    await proxyFetch("/signals", { headers: { "X-Base": "high" } });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://backend.test/api/signals",
      expect.objectContaining({
        headers: {
          "ngrok-skip-browser-warning": "1",
          "X-Base": "high",
          Authorization: "Bearer tok-1",
        },
      }),
    );
  });

  it("retries once with the refreshed token on 401", async () => {
    const refreshAuth = vi.fn(async () => "tok-2");
    configure({ refreshAuth });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401))
      .mockResolvedValueOnce(jsonResponse(200));

    const res = await proxyFetch("/settings");

    expect(res.status).toBe(200);
    expect(refreshAuth).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://backend.test/api/settings",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer tok-2" }),
      }),
    );
  });

  it("returns the original 401 when refresh fails (or is absent)", async () => {
    configure({ refreshAuth: async () => null });
    fetchMock.mockResolvedValueOnce(jsonResponse(401));

    const res = await proxyFetch("/settings");

    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fires onAuthInvalid when refresh yields no token (session unrecoverable)", async () => {
    const onAuthInvalid = vi.fn();
    configure({ refreshAuth: async () => null, onAuthInvalid });
    fetchMock.mockResolvedValueOnce(jsonResponse(401));

    const res = await proxyFetch("/settings");

    expect(res.status).toBe(401);
    expect(onAuthInvalid).toHaveBeenCalledTimes(1);
  });

  it("fires onAuthInvalid when the freshly refreshed token is still rejected", async () => {
    const onAuthInvalid = vi.fn();
    configure({ refreshAuth: async () => "tok-2", onAuthInvalid });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401))
      .mockResolvedValueOnce(jsonResponse(401));

    const res = await proxyFetch("/settings");

    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onAuthInvalid).toHaveBeenCalledTimes(1);
  });

  it("does not fire onAuthInvalid when the retry succeeds", async () => {
    const onAuthInvalid = vi.fn();
    configure({ refreshAuth: async () => "tok-2", onAuthInvalid });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401))
      .mockResolvedValueOnce(jsonResponse(200));

    const res = await proxyFetch("/settings");

    expect(res.status).toBe(200);
    expect(onAuthInvalid).not.toHaveBeenCalled();
  });
});

describe("pinaiFetch", () => {
  it("hits the raw path without the /api prefix", async () => {
    configure();
    fetchMock.mockResolvedValueOnce(jsonResponse(200));

    await pinaiFetch("/api/devices/list");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://backend.test/api/devices/list",
      expect.anything(),
    );
  });
});

describe("proxyPost", () => {
  it("sends JSON with Content-Type", async () => {
    configure();
    fetchMock.mockResolvedValueOnce(jsonResponse(200));

    await proxyPost("/conversation/send", { message: "hi" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://backend.test/api/conversation/send",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ message: "hi" }),
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
      }),
    );
  });
});

describe("proxySSE", () => {
  it("parses data lines, skips keepalives, stops at [DONE]", async () => {
    configure();
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        'data: {"a":1}\n: ping\n',
        'data: {"a":', // 跨 chunk 的半行
        '2}\ndata: [DONE]\ndata: {"a":3}\n',
      ]),
    );

    const events: unknown[] = [];
    for await (const ev of proxySSE("/ambient/summary", {})) events.push(ev);

    expect(events).toEqual([{ a: 1 }, { a: 2 }]);
  });
});

describe("proxyGetSSE", () => {
  it("tags each event with the preceding id: line (resume cursor)", async () => {
    configure();
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        'id: 1-1\ndata: {"t":"x"}\n',
        'data: {"t":"y"}\nid: 2-0\ndata: {"t":"z"}\n',
      ]),
    );

    const seen: Array<{ event: unknown; lastEventId: string | null }> = [];
    for await (const item of proxyGetSSE("/conversation/stream?session=s")) {
      seen.push(item);
    }

    expect(seen).toEqual([
      { event: { t: "x" }, lastEventId: "1-1" },
      { event: { t: "y" }, lastEventId: "1-1" },
      { event: { t: "z" }, lastEventId: "2-0" },
    ]);
  });
});
