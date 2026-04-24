/**
 * Browser lifecycle event bus.
 */
import { EventEmitter } from 'node:events';

export interface BrowserOpenedEvent {
  type: 'browser:opened';
  sessionKey: string;
  browserSessionId: string;
  liveViewUrl: string;
  viewport: { width: number; height: number };
  url: string;
  controlMode?: 'ai' | 'user' | 'idle';
  takeoverReason?: string | null;
  controlUpdatedAt?: number;
}

export interface BrowserNavigatedEvent {
  type: 'browser:navigated';
  sessionKey: string;
  browserSessionId: string;
  url: string;
}

export interface BrowserClosedEvent {
  type: 'browser:closed';
  sessionKey: string;
  browserSessionId: string;
}

export interface BrowserControlEvent {
  type: 'browser:control';
  sessionKey: string;
  browserSessionId: string;
  mode: 'ai' | 'user' | 'idle';
  reason?: string;
}

/**
 * AI has hit a step it cannot complete autonomously (captcha, 2FA, ambiguous
 * UI) and is asking the human to drive the browser. Distinct from
 * browser:control so the frontend can show a dedicated "AI is waiting for
 * you" overlay with the reason — plain mode=user switches (the user
 * clicking "Take Control" themselves) should not trigger that overlay.
 */
export interface BrowserTakeoverRequestedEvent {
  type: 'browser:takeover-requested';
  sessionKey: string;
  browserSessionId: string;
  reason: string;
}

export type BrowserEvent =
  | BrowserOpenedEvent
  | BrowserNavigatedEvent
  | BrowserClosedEvent
  | BrowserControlEvent
  | BrowserTakeoverRequestedEvent;

class BrowserEventBus {
  private emitter = new EventEmitter();
  private activeSessions = new Map<string, BrowserOpenedEvent>();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  emit(event: BrowserEvent): void {
    if (event.type === 'browser:opened') {
      this.activeSessions.set(event.sessionKey, {
        ...event,
        controlMode: event.controlMode ?? 'ai',
        takeoverReason: event.takeoverReason ?? null,
        controlUpdatedAt: event.controlUpdatedAt ?? Date.now(),
      });
    } else if (event.type === 'browser:takeover-requested') {
      const active = this.activeSessions.get(event.sessionKey);
      if (active && active.browserSessionId === event.browserSessionId) {
        this.activeSessions.set(event.sessionKey, {
          ...active,
          controlMode: 'user',
          takeoverReason: event.reason,
          controlUpdatedAt: Date.now(),
        });
      }
    } else if (event.type === 'browser:control') {
      const active = this.activeSessions.get(event.sessionKey);
      if (active && active.browserSessionId === event.browserSessionId) {
        this.activeSessions.set(event.sessionKey, {
          ...active,
          controlMode: event.mode,
          takeoverReason: event.mode === 'ai' ? null : event.reason ?? active.takeoverReason ?? null,
          controlUpdatedAt: Date.now(),
        });
      }
    } else if (event.type === 'browser:closed') {
      this.activeSessions.delete(event.sessionKey);
    }
    this.emitter.emit(event.sessionKey, event);
    this.emitter.emit('*', event);
  }

  on(sessionKey: string, listener: (event: BrowserEvent) => void): () => void {
    this.emitter.on(sessionKey, listener);
    return () => { this.emitter.off(sessionKey, listener); };
  }

  onAll(listener: (event: BrowserEvent) => void): () => void {
    this.emitter.on('*', listener);
    return () => { this.emitter.off('*', listener); };
  }

  getActiveSession(sessionKey: string): BrowserOpenedEvent | undefined {
    return this.activeSessions.get(sessionKey);
  }

  hasActiveSession(sessionKey: string): boolean {
    return this.activeSessions.has(sessionKey);
  }

  clear(): void {
    this.activeSessions.clear();
    this.emitter.removeAllListeners();
  }
}

export const browserEvents = new BrowserEventBus();
