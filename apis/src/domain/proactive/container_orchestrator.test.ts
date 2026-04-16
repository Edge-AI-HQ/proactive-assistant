import test from 'node:test';
import assert from 'node:assert/strict';

import { mapRuntimeStateToContainerStatus } from './container_orchestrator.js';

test('mapRuntimeStateToContainerStatus maps exited containers to stopped', () => {
  assert.equal(mapRuntimeStateToContainerStatus('stopped'), 'stopped');
  assert.equal(mapRuntimeStateToContainerStatus('running'), 'running');
  assert.equal(mapRuntimeStateToContainerStatus('suspended'), 'suspended');
});

test('mapRuntimeStateToContainerStatus treats unknown as error and missing as null', () => {
  assert.equal(mapRuntimeStateToContainerStatus('unknown'), 'error');
  assert.equal(mapRuntimeStateToContainerStatus('error'), 'error');
  assert.equal(mapRuntimeStateToContainerStatus('missing'), null);
});
