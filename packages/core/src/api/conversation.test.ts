import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../transport/http", () => ({
  proxyFetch: vi.fn(),
  proxyPost: vi.fn(),
}));

import { proxyFetch, proxyPost } from "../transport/http";
import {
  conversationDeleteMessage,
  conversationSend,
  conversationUpdateMessage,
} from "./conversation";

const proxyFetchMock = proxyFetch as unknown as ReturnType<typeof vi.fn>;
const proxyPostMock = proxyPost as unknown as ReturnType<typeof vi.fn>;

function ok(status = 200) {
  return new Response("{}", { status });
}

describe("conversation API client", () => {
  beforeEach(() => {
    proxyFetchMock.mockReset();
    proxyPostMock.mockReset();
    proxyFetchMock.mockResolvedValue(ok());
    proxyPostMock.mockResolvedValue(ok(202));
  });

  test("conversationSend can request an interrupting force-send", async () => {
    await conversationSend("main-1", "urgent", {
      clientMsgId: "queued-1",
      interrupt: true,
    });

    expect(proxyPostMock).toHaveBeenCalledWith(
      "/conversation/send",
      {
        session_key: "main-1",
        message: "urgent",
        clientMsgId: "queued-1",
        interrupt: true,
      },
      undefined,
    );
  });

  test("conversationUpdateMessage patches a queued message by client id", async () => {
    await conversationUpdateMessage("main-1", "queued-1", "edited");

    expect(proxyFetchMock).toHaveBeenCalledWith(
      "/conversation/message",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_key: "main-1",
          clientMsgId: "queued-1",
          message: "edited",
        }),
      },
    );
  });

  test("conversationDeleteMessage deletes a queued message by client id", async () => {
    await conversationDeleteMessage("main-1", "queued-1");

    expect(proxyFetchMock).toHaveBeenCalledWith(
      "/conversation/message",
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_key: "main-1",
          clientMsgId: "queued-1",
        }),
      },
    );
  });
});
