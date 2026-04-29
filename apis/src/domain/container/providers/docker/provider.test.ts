/**
 * Integration test for the Docker provider that proactive-ai relies on.
 * Spawns a real container using the configured OPENCLAW_IMAGE to verify the
 * rewrite still:
 *   - calls dockerode with valid create+start args
 *   - extracts the auto-assigned host port into ContainerRef.metadata.hostPort
 *     after start (the prod bug surfaced as `socket hang up` because the
 *     proxy was falling back to the internal port)
 *   - hands resolveGatewayTarget the right host:port
 *
 * Skips when Docker is unreachable OR when the configured image isn't
 * available locally (e.g. running tests against a .env that points at the
 * Fly registry — the daemon can't pull without auth).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Docker from 'dockerode';

import { dockerContainerRuntime } from './provider.js';
import { config } from '../../../common/config.js';

const isDockerAvailable = async (): Promise<boolean> => {
  try {
    const d = new Docker();
    await d.ping();
    return true;
  } catch {
    return false;
  }
};

const isImageLocallyAvailable = async (image: string): Promise<boolean> => {
  try {
    const d = new Docker();
    await d.getImage(image).inspect();
    return true;
  } catch {
    return false;
  }
};

const dockerOnline = await isDockerAvailable();
const imageReady = dockerOnline && await isImageLocallyAvailable(config.openclaw.image);
const skipReason =
  !dockerOnline ? 'Docker daemon unreachable' :
  !imageReady ? `Configured OPENCLAW_IMAGE not pulled locally (${config.openclaw.image})` :
  undefined;
if (skipReason) {
  console.log(`[docker provider test] skipping integration tests: ${skipReason}`);
}

test('docker createGenericContainer + startContainer populates hostPort metadata', { skip: skipReason }, async () => {
  // Use a name unique per test run so reruns don't collide.
  const name = `proactive-test-${Date.now()}`;

  const created = await dockerContainerRuntime.createGenericContainer({
    containerName: name,
    gatewayToken: 'test-token-not-used-in-this-test',
    // Minimal env — the openclaw image will read OPENCLAW_GATEWAY_PORT and
    // bind to it; we don't need the gateway to actually come up healthy,
    // just for dockerd to allocate the port mapping at start().
    env: {},
  });

  try {
    await dockerContainerRuntime.startContainer(created.id);

    // After start, fetch a fresh ref via findContainer to make sure
    // the metadata round-trip matches what the orchestrator stores in DB.
    const ref = await dockerContainerRuntime.findContainer(created.id, [name]);
    assert.ok(ref, 'findContainer should locate the just-started container');
    assert.equal(ref.name, name);

    const hostPort = Number(ref.metadata.hostPort);
    assert.ok(
      Number.isFinite(hostPort) && hostPort > 0,
      `metadata.hostPort must be a real port number, got ${JSON.stringify(ref.metadata.hostPort)}`,
    );
    assert.notEqual(
      String(hostPort),
      '0',
      'hostPort must not be "0" — that would mean dockerd never assigned a port',
    );

    // resolveGatewayTarget must use the actual hostPort, not the
    // internal gateway port fallback. That fallback was the bug:
    // "socket hang up" came from the apis proxy connecting to
    // host.docker.internal:18789 (nothing listening) instead of
    // host.docker.internal:<auto-assigned>.
    const target = dockerContainerRuntime.resolveGatewayTarget(ref);
    assert.equal(
      target.port,
      hostPort,
      `resolveGatewayTarget.port (${target.port}) must match metadata.hostPort (${hostPort})`,
    );
    assert.match(target.httpBaseUrl, new RegExp(`:${hostPort}$`), 'httpBaseUrl ends with the host port');
  } finally {
    await dockerContainerRuntime.destroyContainer(created.id).catch(() => {});
  }
});

test('docker findContainer falls back to name when ref is missing', { skip: skipReason }, async () => {
  const name = `proactive-test-${Date.now()}-fallback`;
  const created = await dockerContainerRuntime.createGenericContainer({
    containerName: name,
    gatewayToken: 'test',
    env: {},
  });

  try {
    // Pretend we lost the runtime ref (e.g. fresh apis pod restart with
    // only the container_name in the DB). findContainer should still locate
    // the container by its compose-friendly name.
    const ref = await dockerContainerRuntime.findContainer(null, [name]);
    assert.ok(ref, 'findContainer should locate by fallback name');
    assert.equal(ref.id, created.id);
  } finally {
    await dockerContainerRuntime.destroyContainer(created.id).catch(() => {});
  }
});

test('docker findContainer returns null for unknown ref + name', { skip: skipReason }, async () => {
  const ref = await dockerContainerRuntime.findContainer(
    'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    ['proactive-does-not-exist-12345'],
  );
  assert.equal(ref, null);
});

/**
 * destroyContainer MUST NOT touch the host bind-mount dir — otherwise a
 * Recreate (orchestrator.resetContainer) would silently lose the user's
 * workspace, agents state, cron jobs, and OpenClaw caches. The dir is
 * only wiped by the dedicated destroyContainerVolume below, which
 * orchestrator.deleteAccount calls after destroyContainer.
 */
test('docker destroyContainer leaves the host-side data dir intact', { skip: skipReason }, async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');

  const name = `proactive-test-${Date.now()}-preserve`;
  const created = await dockerContainerRuntime.createGenericContainer({
    containerName: name,
    gatewayToken: 'test',
    env: {},
  });
  const dataDir = path.join(process.cwd(), 'data', name);
  fs.mkdirSync(path.join(dataDir, '.openclaw'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, '.openclaw', 'workspace.md'), 'user notes');

  await dockerContainerRuntime.destroyContainer(created.id);

  assert.equal(
    fs.existsSync(path.join(dataDir, '.openclaw', 'workspace.md')),
    true,
    'destroyContainer must preserve user workspace data',
  );

  // Cleanup: the dedicated volume-destroy method should wipe it.
  await dockerContainerRuntime.destroyContainerVolume({ containerName: name });
  assert.equal(
    fs.existsSync(dataDir),
    false,
    'destroyContainerVolume must wipe the host data dir',
  );
});

test('docker destroyContainerVolume is idempotent for missing dirs', { skip: skipReason }, async () => {
  // No prior createGenericContainer — dir doesn't exist; method must not throw.
  await dockerContainerRuntime.destroyContainerVolume({
    containerName: `proactive-test-${Date.now()}-noop`,
  });
});
