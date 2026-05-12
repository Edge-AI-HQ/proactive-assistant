import { Contacts } from '@capacitor-community/contacts';
import type { PermissionState } from '@capacitor/core';

import { CadenceGate } from '../../shared/cadence-gate';
import { EventEmitter } from '../../shared/event-emitter';
import { normalizeIdentity } from '../../shared/identity-normalizer';
import { ensureNative } from '../../shared/platform';

import type {
  ContactsPermissions,
  ContactsPlugin,
  ContactsSnapshot,
} from './definitions';

const POLL_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TICK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Contacts adapter — wraps `@capacitor-community/contacts.getContacts()`.
 * Emits aggregated counts only (`total`, `withEmail`, `withPhone`); the raw
 * contact list is intentionally not exposed (privacy: aggregated stats are
 * sufficient for the ambient runtime, the full list never needs to leave
 * the device through this surface).
 *
 * Cadence: 24h between emissions; ticks hourly (cheap aggregation).
 *
 * Foreground only — `setInterval` is suspended in iOS background.
 */
export class ContactsAdapter extends EventEmitter implements ContactsPlugin {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private gate = new CadenceGate(POLL_INTERVAL_MS);

  constructor() {
    super('Contacts');
  }

  async requestPermissions(): Promise<ContactsPermissions> {
    if (!ensureNative('Contacts')) return { contacts: 'denied' };
    const result = await Contacts.requestPermissions();
    return { contacts: normalizePermission(result.contacts) };
  }

  async checkPermissions(): Promise<ContactsPermissions> {
    if (!ensureNative('Contacts')) return { contacts: 'denied' };
    const result = await Contacts.checkPermissions();
    return { contacts: normalizePermission(result.contacts) };
  }

  async startMonitoring(): Promise<void> {
    if (!ensureNative('Contacts')) return;
    if (this.intervalId !== null) return;

    this.gate.reset();
    await this.tick();
    this.intervalId = setInterval(() => {
      void this.tick();
    }, TICK_INTERVAL_MS);
  }

  async stopMonitoring(): Promise<void> {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.gate.reset();
  }

  private async tick(): Promise<void> {
    if (!this.gate.shouldRun()) return;
    const snapshot = await this.collect();
    this.emitTyped('contacts', snapshot);
  }

  private async collect(): Promise<ContactsSnapshot> {
    const result = await Contacts.getContacts({
      projection: { name: true, phones: true, emails: true },
    });
    const contacts = result.contacts ?? [];
    let total = 0;
    let withEmail = 0;
    let withPhone = 0;
    for (const c of contacts) {
      total += 1;
      const hasEmail = (c.emails ?? []).some((e) => {
        const addr = e.address;
        return typeof addr === 'string' && normalizeIdentity(addr, 'email').normalized.length > 0;
      });
      const hasPhone = (c.phones ?? []).some((p) => {
        const num = p.number;
        return typeof num === 'string' && normalizeIdentity(num, 'phone').normalized.length > 0;
      });
      if (hasEmail) withEmail += 1;
      if (hasPhone) withPhone += 1;
    }
    return { total, withEmail, withPhone, timestamp: Date.now() };
  }
}

function normalizePermission(state: PermissionState | 'limited'): PermissionState {
  return state === 'limited' ? 'granted' : state;
}
