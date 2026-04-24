import test from 'node:test';
import assert from 'node:assert/strict';

import { browserEvents } from './events.js';

test('active browser state keeps takeover reason across control events', () => {
  browserEvents.clear();

  browserEvents.emit({
    type: 'browser:opened',
    sessionKey: 'agent:main:proactive-ai:chat:test',
    browserSessionId: 'session-1',
    liveViewUrl: 'https://live.example.test',
    viewport: { width: 390, height: 844 },
    url: 'https://example.test',
  });
  browserEvents.emit({
    type: 'browser:takeover-requested',
    sessionKey: 'agent:main:proactive-ai:chat:test',
    browserSessionId: 'session-1',
    reason: 'Complete the SMS verification',
  });

  const active = browserEvents.getActiveSession('agent:main:proactive-ai:chat:test') as
    | { controlMode?: string; takeoverReason?: string }
    | undefined;

  assert.equal(active?.controlMode, 'user');
  assert.equal(active?.takeoverReason, 'Complete the SMS verification');

  browserEvents.emit({
    type: 'browser:control',
    sessionKey: 'agent:main:proactive-ai:chat:test',
    browserSessionId: 'session-1',
    mode: 'ai',
  });

  const returned = browserEvents.getActiveSession('agent:main:proactive-ai:chat:test') as
    | { controlMode?: string; takeoverReason?: string | null }
    | undefined;

  assert.equal(returned?.controlMode, 'ai');
  assert.equal(returned?.takeoverReason, null);
});
