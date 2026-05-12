/**
 * Time-based gate used by TS adapters to throttle native plugin output to
 * the data layer. Mirrors `CollectionCadenceGate.swift`.
 *
 * Adapters use this to drop high-frequency native callbacks (e.g. barometer
 * @ ~10Hz) down to a minimum interval before emitting to consumers. Business
 * scheduling (foreground/background, battery awareness) lives in the host
 * runtime, not here.
 */
export class CadenceGate {
  private lastRunAt: number | null = null;

  constructor(private readonly minimumIntervalMs: number) {}

  shouldRun(now: number = Date.now()): boolean {
    if (this.lastRunAt === null) {
      this.lastRunAt = now;
      return true;
    }
    if (now - this.lastRunAt < this.minimumIntervalMs) {
      return false;
    }
    this.lastRunAt = now;
    return true;
  }

  reset(): void {
    this.lastRunAt = null;
  }
}
