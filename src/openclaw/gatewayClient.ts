import crypto from 'node:crypto';
import WebSocket, { type RawData } from 'ws';

type JsonObject = Record<string, unknown>;
type GatewayConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'stopped';

interface GatewayErrorPayload {
  message?: string;
}

interface GatewayResponse {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: GatewayErrorPayload;
}

export interface GatewayEvent {
  type: 'event';
  event: string;
  payload?: unknown;
  seq?: number;
}

export interface GatewayCloseInfo {
  code: number;
  reason: string;
}

export interface GatewayClientOptions {
  url: string;
  token?: string;
  password?: string;
  role?: string;
  scopes?: string[];
  clientName?: string;
  clientVersion?: string;
  platform?: string;
  mode?: string;
  caps?: string[];
  commands?: string[];
  permissions?: JsonObject;
  userAgent?: string;
  locale?: string;
  onHello?: (hello: JsonObject) => void;
  onClose?: (info: GatewayCloseInfo) => void;
  onEvent?: (event: GatewayEvent) => void;
  onGap?: (info: { expected: number; received: number }) => void;
  onConnectError?: (error: Error) => void;
  onStateChange?: (state: GatewayConnectionState) => void;
  connectDelayMs?: number;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  expectFinal: boolean;
  method: string;
  timer: NodeJS.Timeout | null;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

interface HelloWaiter {
  resolve: (value: JsonObject) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_PROTOCOL = 3;
const DEFAULT_ROLE = 'operator';
const DEFAULT_SCOPES = ['operator.admin'];
const DEFAULT_INITIAL_BACKOFF_MS = 1000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_CONNECT_DELAY_MS = 750;
const DEFAULT_CONNECT_TIMEOUT_MS = 12_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

const isRecord = (value: unknown): value is JsonObject => {
  return typeof value === 'object' && value !== null;
};

const safeJsonParse = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const rawDataToString = (raw: RawData): string => {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (Array.isArray(raw)) {
    return Buffer.concat(raw).toString('utf8');
  }
  return Buffer.from(raw).toString('utf8');
};

const toGatewayEvent = (value: unknown): GatewayEvent | null => {
  if (!isRecord(value)) return null;
  if (value.type !== 'event') return null;
  if (typeof value.event !== 'string') return null;

  const event: GatewayEvent = {
    type: 'event',
    event: value.event
  };

  if (Object.hasOwn(value, 'payload')) {
    event.payload = value.payload;
  }
  if (typeof value.seq === 'number') {
    event.seq = value.seq;
  }

  return event;
};

const toGatewayResponse = (value: unknown): GatewayResponse | null => {
  if (!isRecord(value)) return null;
  if (value.type !== 'res') return null;
  if (typeof value.id !== 'string' || typeof value.ok !== 'boolean') return null;

  const response: GatewayResponse = {
    type: 'res',
    id: value.id,
    ok: value.ok
  };

  if (Object.hasOwn(value, 'payload')) {
    response.payload = value.payload;
  }
  if (isRecord(value.error) && typeof value.error.message === 'string') {
    response.error = { message: value.error.message };
  }

  return response;
};

export class GatewayClient {
  private readonly opts: GatewayClientOptions;

  private ws: WebSocket | null = null;

  private readonly pending = new Map<string, PendingRequest>();

  private closed = true;

  private state: GatewayConnectionState = 'idle';

  private backoffMs: number;

  private connectSent = false;

  private connectTimer: NodeJS.Timeout | null = null;

  private reconnectTimer: NodeJS.Timeout | null = null;

  private hello: JsonObject | null = null;

  private readonly helloWaiters = new Set<HelloWaiter>();

  private readonly instanceId = crypto.randomUUID();

  private lastSeq: number | null = null;

  constructor(opts: GatewayClientOptions) {
    this.opts = opts;
    this.backoffMs = Math.max(100, opts.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS);
  }

  start(): void {
    if (!this.closed && (this.ws || this.reconnectTimer !== null)) return;
    this.closed = false;
    this.transitionState('connecting');
    this.connect();
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearReconnectTimer();
    this.clearConnectTimer();
    this.transitionState('stopped');
    const active = this.ws;
    this.ws = null;
    active?.close();
    this.flushPending(new Error('gateway client stopped'));
    this.resetHello();
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private connect(): void {
    if (this.closed) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const socket = new WebSocket(this.opts.url, {
      maxPayload: 25 * 1024 * 1024
    });
    this.ws = socket;

    socket.on('open', () => {
      if (this.ws !== socket) return;
      this.transitionState('connected');
      this.queueConnect();
    });
    socket.on('message', (data: RawData) => {
      if (this.ws !== socket) return;
      this.handleMessage(rawDataToString(data));
    });
    socket.on('close', (code: number, reasonBuffer: Buffer) => {
      if (this.ws !== socket) return;
      const reason = reasonBuffer.toString('utf8');
      this.ws = null;
      this.clearConnectTimer();
      this.resetHello();
      this.flushPending(new Error(`gateway closed (${code}): ${reason || 'no reason'}`));
      this.opts.onClose?.({ code, reason });
      this.scheduleReconnect();
    });
    socket.on('error', (error: Error) => {
      if (this.ws !== socket) return;
      this.opts.onConnectError?.(error);
    });
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.reconnectTimer !== null) return;

    this.transitionState('reconnecting');
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed) return;
      this.transitionState('connecting');
      this.connect();
    }, delay);
    this.reconnectTimer.unref();
  }

  private flushPending(error: Error): void {
    for (const [id] of this.pending) {
      this.rejectPending(id, error);
    }
  }

  private resetHello(): void {
    this.hello = null;
    for (const waiter of this.helloWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('gateway disconnected'));
    }
    this.helloWaiters.clear();
  }

  async waitForHello(timeoutMs = 12000): Promise<JsonObject> {
    if (this.hello) return this.hello;
    if (this.closed) {
      return Promise.reject(new Error('gateway client stopped'));
    }
    const effectiveTimeout = Number.isFinite(timeoutMs)
      ? Math.max(100, Math.trunc(timeoutMs))
      : this.opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    return new Promise<JsonObject>((resolve, reject) => {
      const entry: HelloWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.helloWaiters.delete(entry);
          reject(new Error('gateway connect timeout'));
        }, effectiveTimeout)
      };
      this.helloWaiters.add(entry);
      entry.timer.unref();
    });
  }

  private queueConnect(): void {
    this.connectSent = false;
    this.clearConnectTimer();
    const connectDelayMs = Math.max(0, this.opts.connectDelayMs ?? DEFAULT_CONNECT_DELAY_MS);
    this.connectTimer = setTimeout(() => {
      this.sendConnect().catch(() => {});
    }, connectDelayMs);
    this.connectTimer.unref();
  }

  private async sendConnect(): Promise<void> {
    if (this.connectSent) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('gateway not connected');
    }
    this.connectSent = true;
    this.clearConnectTimer();

    const auth = this.opts.token
      ? { token: this.opts.token }
      : this.opts.password
        ? { password: this.opts.password }
        : undefined;

    const role = this.opts.role ?? DEFAULT_ROLE;
    const scopes = this.opts.scopes ?? DEFAULT_SCOPES;

    const payload = {
      minProtocol: DEFAULT_PROTOCOL,
      maxProtocol: DEFAULT_PROTOCOL,
      client: {
        id: this.opts.clientName ?? 'gateway-client',
        version: this.opts.clientVersion ?? 'dev',
        platform: this.opts.platform ?? process.platform,
        mode: this.opts.mode ?? 'backend',
        instanceId: this.instanceId
      },
      role,
      scopes,
      caps: this.opts.caps ?? [],
      commands: this.opts.commands ?? [],
      permissions: this.opts.permissions ?? {},
      auth,
      userAgent: this.opts.userAgent ?? 'pinai-backend',
      locale: this.opts.locale ?? 'en-US'
    };

    try {
      const hello = await this.request<JsonObject>('connect', payload, {
        timeoutMs: this.opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
      });
      this.backoffMs = Math.max(100, this.opts.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS);
      this.hello = hello ?? {};
      for (const waiter of this.helloWaiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(this.hello);
      }
      this.helloWaiters.clear();
      this.opts.onHello?.(this.hello);
    } catch (error: unknown) {
      console.error('[gateway] connect failed', error);
      this.ws?.close(4008, 'connect failed');
      throw error;
    }
  }

  private handleMessage(raw: string): void {
    const data = safeJsonParse(raw);

    const event = toGatewayEvent(data);
    if (event) {
      if (event.event === 'connect.challenge') {
        this.sendConnect().catch(() => {});
        return;
      }

      if (typeof event.seq === 'number') {
        if (this.lastSeq !== null && event.seq > this.lastSeq + 1) {
          this.opts.onGap?.({ expected: this.lastSeq + 1, received: event.seq });
        }
        this.lastSeq = event.seq;
      }

      this.opts.onEvent?.(event);
      return;
    }

    const response = toGatewayResponse(data);
    if (!response) return;

    const pending = this.pending.get(response.id);
    if (!pending) return;

    const status =
      isRecord(response.payload) && typeof response.payload.status === 'string'
        ? response.payload.status
        : null;
    if (pending.expectFinal && status === 'accepted') {
      return;
    }

    if (response.ok) {
      this.resolvePending(response.id, response.payload);
      return;
    }

    this.rejectPending(response.id, new Error(response.error?.message ?? 'request failed'));
  }

  request<T = unknown>(
    method: string,
    params: JsonObject = {},
    opts?: { expectFinal?: boolean; timeoutMs?: number; signal?: AbortSignal }
  ): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('gateway not connected'));
    }

    const id = crypto.randomUUID();
    const frame = { type: 'req', id, method, params };
    const expectFinal = opts?.expectFinal === true;
    const timeoutMsRaw = opts?.timeoutMs ?? this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const timeoutMs =
      Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? Math.trunc(timeoutMsRaw) : DEFAULT_REQUEST_TIMEOUT_MS;
    const signal = opts?.signal;
    const abortError = signal?.aborted ? new Error(`gateway request aborted: ${method}`) : null;
    if (abortError) {
      return Promise.reject(abortError);
    }

    const promise = new Promise<T>((resolve, reject) => {
      const entry: PendingRequest = {
        resolve: (value: unknown) => resolve(value as T),
        reject: (reason: Error) => reject(reason),
        expectFinal,
        method,
        timer: null
      };

      if (signal) {
        const abortHandler = () => {
          this.rejectPending(id, new Error(`gateway request aborted: ${method}`));
        };
        signal.addEventListener('abort', abortHandler, { once: true });
        entry.signal = signal;
        entry.abortHandler = abortHandler;
      }

      entry.timer = setTimeout(() => {
        this.rejectPending(id, new Error(`gateway request timeout after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      entry.timer.unref();
      this.pending.set(id, entry);
    });

    try {
      this.ws.send(JSON.stringify(frame), (error?: Error) => {
        if (!error) return;
        this.rejectPending(id, new Error(`gateway send failed: ${error.message}`));
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.rejectPending(id, new Error(`gateway send failed: ${message}`));
    }

    return promise;
  }

  private resolvePending(id: string, payload: unknown): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    this.cleanupPending(pending);
    pending.resolve(payload);
  }

  private rejectPending(id: string, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    this.cleanupPending(pending);
    pending.reject(error);
  }

  private cleanupPending(pending: PendingRequest): void {
    if (pending.timer !== null) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    if (pending.signal && pending.abortHandler) {
      pending.signal.removeEventListener('abort', pending.abortHandler);
      delete pending.abortHandler;
      delete pending.signal;
    }
  }

  private clearConnectTimer(): void {
    if (this.connectTimer === null) return;
    clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private transitionState(nextState: GatewayConnectionState): void {
    if (this.state === nextState) return;
    this.state = nextState;
    this.opts.onStateChange?.(nextState);
  }
}
