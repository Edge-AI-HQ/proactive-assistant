export interface AmbientStartSession {
  readonly id: number;
  readonly userId: string;
}

export type AmbientStartResult = "started" | "empty" | "cancelled";

export class AmbientLifecycleController {
  private generation = 0;
  private activeStart: AmbientStartSession | null = null;

  running = false;
  ownerUserId: string | null = null;
  startedSourceKeys: string[] = [];
  interactivePermissions = true;

  beginStart(userId: string, interactivePermissions: boolean): AmbientStartSession {
    this.generation += 1;
    const session = { id: this.generation, userId };
    this.activeStart = session;
    this.running = false;
    this.ownerUserId = userId;
    this.startedSourceKeys = [];
    this.interactivePermissions = interactivePermissions;
    return session;
  }

  isCurrentStart(session: AmbientStartSession): boolean {
    return this.activeStart?.id === session.id && this.ownerUserId === session.userId;
  }

  completeStart(session: AmbientStartSession, startedSourceKeys: string[]): AmbientStartResult {
    if (!this.isCurrentStart(session)) return "cancelled";
    this.activeStart = null;
    this.running = startedSourceKeys.length > 0;
    this.startedSourceKeys = startedSourceKeys;
    if (!this.running) {
      this.ownerUserId = null;
      this.interactivePermissions = true;
      return "empty";
    }
    return "started";
  }

  stop(): void {
    this.generation += 1;
    this.activeStart = null;
    this.running = false;
    this.ownerUserId = null;
    this.startedSourceKeys = [];
    this.interactivePermissions = true;
  }

  runningFor(userId: string): boolean {
    return this.running && this.ownerUserId === userId;
  }
}
