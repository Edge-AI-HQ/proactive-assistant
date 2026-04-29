/**
 * Verifies the stable-readiness probe policy that gates `ready: true` on
 * `/container/ensure` and `/container/reset`. Single-probe success is not
 * enough during OpenClaw plugin reload storms — the helper must:
 *
 *   - require TWO consecutive successful probes separated by stablePeriod
 *   - retry across reload-induced flaps until totalTimeout
 *   - return false after totalTimeout instead of hanging the orchestrator
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ContainerRef, ContainerRuntime, ProbeOptions } from '../container/contracts.js';
import { waitForStableReady } from './container_orchestrator.js';

const fakeRef: ContainerRef = {
  id: 'fake',
  name: 'proactive-test',
  state: 'running',
  metadata: {},
};

interface ScriptedRuntimeOpts {
  /** Each entry resolves the next probeReady() call. true=ok, false=fail, throw=reject. */
  probeScript: Array<boolean | 'throw'>;
}

const scriptedRuntime = (opts: ScriptedRuntimeOpts): { runtime: ContainerRuntime; calls: number } => {
  const state = { calls: 0 };
  const runtime: ContainerRuntime = {
    name: 'mock',
    async prepare() { /* noop */ },
    async findContainer() { return null; },
    async createGenericContainer() { throw new Error('not used'); },
    async startContainer() { throw new Error('not used'); },
    async stopContainer() { /* noop */ },
    async suspendContainer() { /* noop */ },
    async destroyContainer() { /* noop */ },
    async destroyContainerVolume() { /* noop */ },
    async listContainers() { return []; },
    resolveGatewayTarget() { return { host: '', port: 0, httpBaseUrl: '', wsBaseUrl: '' }; },
    async probeReady(_ref: ContainerRef, _o: ProbeOptions) {
      void _ref; void _o;
      const next = opts.probeScript[state.calls] ?? false;
      state.calls += 1;
      if (next === 'throw') throw new Error('mock probe error');
      return next;
    },
  };
  return { runtime, calls: state.calls };
};

const noSleep = async () => { /* fast-forward in tests */ };

test('waitForStableReady returns true when two consecutive probes succeed', async () => {
  const { runtime } = scriptedRuntime({ probeScript: [true, true] });
  const ok = await waitForStableReady(runtime, fakeRef, {
    gatewayToken: 't',
    gatewayPort: 18789,
    sleepImpl: noSleep,
    stablePeriodMs: 1,
    totalTimeoutMs: 10_000,
  });
  assert.equal(ok, true);
});

test('waitForStableReady rejects single-probe success: must verify stability', async () => {
  // First probe ok, second probe fails (simulates a reload-induced flap).
  // Then both fail (gateway in middle of reload), then both succeed (recovered).
  const { runtime } = scriptedRuntime({
    probeScript: [
      true,   // up
      false,  // → went down during stable window: reload happened
      false,  // still down
      true,   // back up
      true,   // confirmed stable
    ],
  });
  const ok = await waitForStableReady(runtime, fakeRef, {
    gatewayToken: 't',
    gatewayPort: 18789,
    sleepImpl: noSleep,
    stablePeriodMs: 1,
    totalTimeoutMs: 10_000,
  });
  assert.equal(ok, true);
});

test('waitForStableReady tolerates probeReady throwing (treat as not-ready)', async () => {
  const { runtime } = scriptedRuntime({
    probeScript: ['throw', 'throw', true, true],
  });
  const ok = await waitForStableReady(runtime, fakeRef, {
    gatewayToken: 't',
    gatewayPort: 18789,
    sleepImpl: noSleep,
    stablePeriodMs: 1,
    totalTimeoutMs: 10_000,
  });
  assert.equal(ok, true);
});

test('waitForStableReady returns false after total timeout', async () => {
  // Always fails — must not hang.
  const probeScript: boolean[] = [];
  for (let i = 0; i < 1000; i++) probeScript.push(false);
  const { runtime } = scriptedRuntime({ probeScript });

  const ok = await waitForStableReady(runtime, fakeRef, {
    gatewayToken: 't',
    gatewayPort: 18789,
    sleepImpl: noSleep,
    stablePeriodMs: 1,
    totalTimeoutMs: 50,        // very short for the test
  });
  assert.equal(ok, false);
});

test('waitForStableReady returns false when up-then-down-loop never stabilizes', async () => {
  // Pattern: up, down, up, down, ... Never two consecutive ups. Caller
  // must give up by deadline rather than spinning forever.
  const probeScript: boolean[] = [];
  for (let i = 0; i < 1000; i++) probeScript.push(i % 2 === 0);
  const { runtime } = scriptedRuntime({ probeScript });

  const ok = await waitForStableReady(runtime, fakeRef, {
    gatewayToken: 't',
    gatewayPort: 18789,
    sleepImpl: noSleep,
    stablePeriodMs: 1,
    totalTimeoutMs: 30,
  });
  assert.equal(ok, false);
});
