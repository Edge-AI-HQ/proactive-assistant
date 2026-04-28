import assert from "node:assert/strict";
import test from "node:test";
import { WebSocketServer } from "ws";

import type { GatewayTarget } from "../container/contracts.js";
import { setCurrentModel } from "./gateway_rpc.js";

const startGateway = async (options: {
  currentModel?: string;
  patchDelayMs?: number;
} = {}): Promise<{
  close: () => Promise<void>;
  getPatchCount: () => number;
  target: GatewayTarget;
}> => {
  const currentModel = options.currentModel ?? "litellm/kimi-k2.5";
  const patchDelayMs = options.patchDelayMs ?? 0;
  let patchCount = 0;
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;

  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as {
        id?: string;
        method?: string;
        type?: string;
      };
      if (msg.type !== "req" || !msg.id) return;

      if (msg.method === "connect") {
        socket.send(JSON.stringify({ type: "res", id: msg.id, ok: true }));
        return;
      }

      if (msg.method === "config.get") {
        socket.send(
          JSON.stringify({
            type: "res",
            id: msg.id,
            ok: true,
            payload: {
              hash: "hash-1",
              config: {
                agents: {
                  defaults: {
                    model: { primary: currentModel },
                  },
                },
              },
            },
          }),
        );
        return;
      }

      if (msg.method === "config.patch") {
        patchCount += 1;
        setTimeout(() => {
          socket.send(JSON.stringify({ type: "res", id: msg.id, ok: true }));
        }, patchDelayMs);
      }
    });
  });

  return {
    target: {
      host: "127.0.0.1",
      port,
      httpBaseUrl: `http://127.0.0.1:${port}`,
      wsBaseUrl: `ws://127.0.0.1:${port}`,
    },
    getPatchCount: () => patchCount,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
};

test("setCurrentModel waits for slow config.patch responses", async () => {
  const gateway = await startGateway({ patchDelayMs: 10_500 });
  try {
    const result = await setCurrentModel(
      gateway.target,
      "gateway-token",
      "litellm/claude-opus-4-6",
    );

    assert.deepEqual(result, { ok: true, payload: undefined });
  } finally {
    await gateway.close();
  }
});

test("setCurrentModel skips config.patch when the model is unchanged", async () => {
  const gateway = await startGateway({
    currentModel: "litellm/kimi-k2.5",
  });
  try {
    const result = await setCurrentModel(
      gateway.target,
      "gateway-token",
      "litellm/kimi-k2.5",
    );

    assert.deepEqual(result, { ok: true, payload: undefined });
    assert.equal(gateway.getPatchCount(), 0);
  } finally {
    await gateway.close();
  }
});
