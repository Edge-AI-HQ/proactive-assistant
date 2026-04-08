import { describe, it, expect } from 'vitest';
import {
  loadAutoLoopState,
  saveAutoLoopState,
} from './pending-store.js';

describe('pending-store', () => {
  describe('auto loop state', () => {
    it('returns empty defaults when no state is saved', () => {
      const state = loadAutoLoopState();
      expect(state).toHaveProperty('lastStartedAt');
      expect(state).toHaveProperty('lastFinishedAt');
      expect(state).toHaveProperty('lastStatus');
    });

    it('round-trips auto loop state', () => {
      const now = new Date().toISOString();
      saveAutoLoopState({ lastStartedAt: now, lastStatus: 'success' });
      const state = loadAutoLoopState();
      expect(state.lastStartedAt).toBe(now);
      expect(state.lastStatus).toBe('success');
    });
  });
});
