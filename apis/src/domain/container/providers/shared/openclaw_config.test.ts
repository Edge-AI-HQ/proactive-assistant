import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildOpenclawConfig,
  type OpenclawConfigContext,
} from './openclaw_config.js';

const context: OpenclawConfigContext = {
  openclaw: {
    image: 'registry.fly.io/proactive-ai-openclaw@sha256:test',
    gatewayPort: 18789,
    braveApiKey: '',
  },
  litellm: {
    enabled: false,
    baseUrl: '',
    masterKey: '',
    requestTimeoutMs: 30000,
    syncIntervalMs: 60000,
    keyAliasPrefix: 'test',
    defaultBudgetUsd: null,
    defaultBudgetDuration: '1mo',
    defaultRpmLimit: null,
    defaultTpmLimit: null,
    allowedModels: [],
    openclawDefaultModel: '',
  },
  elevenLabs: {
    apiKey: '',
    baseUrl: 'https://api.elevenlabs.io',
  },
};

test('buildOpenclawConfig disables mDNS discovery when requested', () => {
  const config = buildOpenclawConfig(context, {
    gatewayToken: 'test-token',
    gatewayBind: 'loopback',
    mdnsMode: 'off',
  });

  assert.deepEqual(config.discovery, {
    mdns: { mode: 'off' },
  });
});
