import crypto from 'node:crypto';
import WebSocket, { type RawData } from 'ws';

type JsonObject = Record<string, unknown>;

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
  payload?: JsonObject;
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
  caps?: unknown[];
  commands?: unknown[];
  permissions?: JsonObject;
  userAgent?: string;
  locale?: string;
  onHello?: (hello: JsonObject) => void;
  onClose?: (info: GatewayCloseInfo) => void;
  onEvent?: (event: GatewayEvent) => void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

interface HelloWaiter {
  resolve: (value: JsonObject) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_PROTOCOL = 3;
const DEFAULT_ROLE = 'operator';
const DEFAULT_SCOPES = ['operator.admin'];

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

const toGatewayEvent = (value: unknown): GatewayEvent | null => {
  if (!isRecord(value)) return null;
  if (value.type !== 'event') return null;
  if (typeof value.event !== 'string') return null;
  const payload = isRecord(value.payload) ? value.payload : undefined;
  if (payload) {
    return { type: 'event', event: value.event, payload };
  }
  return { type: 'event', event: value.event };
};

const toGatewayResponse = (value: unknown): GatewayResponse | null => {
  if (!isRecord(value)) return null;
  if (value.type !== 'res') return null;
  if (typeof value.id !== 'string' || typeof value.ok !== 'boolean') return null;
  let error: GatewayErrorPayload | undefined;
  if (isRecord(value.error) && typeof value.error.message === 'string') {
    error = { message: value.error.message };
  }
  const response: GatewayResponse = {
    type: 'res',
    id: value.id,
    ok: value.ok,
    payload: value.payload
  };
  if (error) {
    response.error = error;
  }
  return response;
};

export class GatewayClient {
  private readonly opts: GatewayClientOptions;

  private ws: WebSocket | null = null;

  private readonly pending = new Map<string, PendingRequest>();

  private closed = false;

  private backoffMs = 800;

  private connectSent = false;

  private connectTimer: NodeJS.Timeout | null = null;

  private connectNonce: string | null = null;

  private hello: JsonObject | null = null;

  private readonly helloWaiters = new Set<HelloWaiter>();

  private readonly instanceId = crypto.randomUUID();

  constructor(opts: GatewayClientOptions) {
    this.opts = opts;
  }

  start(): void {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
    this.flushPending(new Error('gateway client stopped'));
    this.resetHello();
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private connect(): void {
    if (this.closed) return;
    this.ws = new WebSocket(this.opts.url);
    this.ws.on('open', () => this.queueConnect());
    this.ws.on('message', (data: RawData) => this.handleMessage(String(data ?? '')));
    this.ws.on('close', (code: number, reasonBuffer: Buffer) => {
      const reason = String(reasonBuffer ?? Buffer.from(''));
      this.ws = null;
      this.resetHello();
      this.flushPending(new Error(`gateway closed (${code}): ${reason || 'no reason'}`));
      this.opts.onClose?.({ code, reason });
      this.scheduleReconnect();
    });
    this.ws.on('error', () => {});
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 1.7, 15000);
    setTimeout(() => this.connect(), delay);
  }

  private flushPending(error: Error): void {
    for (const [, pending] of this.pending) {
      pending.reject(error);
    }
    this.pending.clear();
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
    return new Promise<JsonObject>((resolve, reject) => {
      const entry: HelloWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.helloWaiters.delete(entry);
          reject(new Error('gateway connect timeout'));
        }, timeoutMs)
      };
      this.helloWaiters.add(entry);
    });
  }

  private queueConnect(): void {
    this.connectNonce = null;
    this.connectSent = false;
    if (this.connectTimer !== null) clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(() => {
      this.sendConnect().catch(() => {});
    }, 750);
  }

  private async sendConnect(): Promise<void> {
    if (this.connectSent) return;
    this.connectSent = true;
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }

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
      const hello = await this.request<JsonObject>('connect', payload);
      this.backoffMs = 800;
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
        const nonce = event.payload?.nonce;
        if (typeof nonce === 'string') {
          this.connectNonce = nonce;
        }
        this.sendConnect().catch(() => {});
        return;
      }
      this.opts.onEvent?.(event);
      return;
    }

    const response = toGatewayResponse(data);
    if (!response) return;

    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);

    if (response.ok) {
      pending.resolve(response.payload);
      return;
    }

    pending.reject(new Error(response.error?.message ?? 'request failed'));
  }

  request<T = unknown>(method: string, params: JsonObject): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('gateway not connected'));
    }
    const id = crypto.randomUUID();
    const payload = { type: 'req', id, method, params };
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value: unknown) => resolve(value as T),
        reject: (reason: Error) => reject(reason)
      });
    });
    this.ws.send(JSON.stringify(payload));
    return promise;
  }
}
