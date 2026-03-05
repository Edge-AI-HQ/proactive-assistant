import test from 'node:test';
import assert from 'node:assert/strict';

import plugin from './index.js';

function createApiStub() {
  const logs = [];
  return {
    logs,
    api: {
      logger: {
        info: (msg) => logs.push({ level: 'info', msg }),
        warn: (msg) => logs.push({ level: 'warn', msg }),
        error: (msg) => logs.push({ level: 'error', msg }),
      },
    },
  };
}

test('rewrites bot method calls to telegram router', async () => {
  const originalFetch = globalThis.fetch;
  const originalRouter = process.env.TELEGRAM_ROUTER_URL;
  delete globalThis.__pinaiTelegramRouterFetchPatched__;

  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  process.env.TELEGRAM_ROUTER_URL = 'https://router.example.com';
  const { api } = createApiStub();

  try {
    plugin.register(api);
    await globalThis.fetch('https://api.telegram.org/bot123456:ABCDEF1234567890/sendMessage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: 1, text: 'hi' }),
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.input, 'https://router.example.com/api/telegram/sendMessage');
    assert.equal(calls[0]?.init?.headers?.get('X-PinAI-Telegram-Bot-Token'), '123456:ABCDEF1234567890');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalRouter === undefined) {
      delete process.env.TELEGRAM_ROUTER_URL;
    } else {
      process.env.TELEGRAM_ROUTER_URL = originalRouter;
    }
    delete globalThis.__pinaiTelegramRouterFetchPatched__;
  }
});

test('rewrites telegram file download calls to telegram router', async () => {
  const originalFetch = globalThis.fetch;
  const originalRouter = process.env.TELEGRAM_ROUTER_URL;
  delete globalThis.__pinaiTelegramRouterFetchPatched__;

  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    return new Response('binary-data', { status: 200 });
  };

  process.env.TELEGRAM_ROUTER_URL = 'https://router.example.com';
  const { api } = createApiStub();

  try {
    plugin.register(api);
    await globalThis.fetch('https://api.telegram.org/file/bot123456:ABCDEF1234567890/photos/pic.jpg');

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.input, 'https://router.example.com/api/telegram/file/photos/pic.jpg');
    assert.equal(calls[0]?.init?.headers?.get('X-PinAI-Telegram-Bot-Token'), '123456:ABCDEF1234567890');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalRouter === undefined) {
      delete process.env.TELEGRAM_ROUTER_URL;
    } else {
      process.env.TELEGRAM_ROUTER_URL = originalRouter;
    }
    delete globalThis.__pinaiTelegramRouterFetchPatched__;
  }
});

test('disables stream for litellm vision chat completions', async () => {
  const originalFetch = globalThis.fetch;
  const originalRouter = process.env.TELEGRAM_ROUTER_URL;
  delete globalThis.__pinaiTelegramRouterFetchPatched__;

  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    return new Response(JSON.stringify({ id: 'ok', choices: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  process.env.TELEGRAM_ROUTER_URL = 'https://router.example.com';
  const { api } = createApiStub();

  try {
    plugin.register(api);
    await globalThis.fetch('https://litellm-dev.fly.dev/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'litellm/minimax-m2.5',
        stream: true,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'describe image' },
              { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,abc' } },
            ],
          },
        ],
      }),
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.input, 'https://litellm-dev.fly.dev/v1/chat/completions');
    const body = JSON.parse(String(calls[0]?.init?.body || '{}'));
    assert.equal(body.stream, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalRouter === undefined) {
      delete process.env.TELEGRAM_ROUTER_URL;
    } else {
      process.env.TELEGRAM_ROUTER_URL = originalRouter;
    }
    delete globalThis.__pinaiTelegramRouterFetchPatched__;
  }
});
