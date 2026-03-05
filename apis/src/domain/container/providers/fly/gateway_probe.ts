import net from 'node:net';
import WebSocket from 'ws';

const FLY_DEFAULT_PORT_TIMEOUT_MS = 120_000;
const CONNECT_PROBE_REQUEST_ID = 'fly-gateway-probe-connect';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const formatHostForUrl = (host: string): string => {
  if (host.includes(':') && !host.startsWith('[')) {
    return `[${host}]`;
  }
  return host;
};

export const waitForPort = (
  host: string,
  port: number,
  timeoutMs = FLY_DEFAULT_PORT_TIMEOUT_MS
): Promise<boolean> =>
  new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;

    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    const scheduleRetry = (): void => {
      if (Date.now() - startedAt >= timeoutMs) {
        finish(false);
        return;
      }
      setTimeout(tryConnect, 1000);
    };

    const tryConnect = (): void => {
      if (settled) return;
      const socket = net.createConnection({ host, port }, () => {
        socket.end();
        finish(true);
      });

      socket.setTimeout(3000);

      socket.on('timeout', () => {
        socket.destroy();
        scheduleRetry();
      });

      socket.on('error', () => {
        socket.destroy();
        scheduleRetry();
      });
    };

    tryConnect();
  });

const probeGatewayHelloOnce = async (host: string, port: number, gatewayToken: string): Promise<boolean> =>
  new Promise((resolve) => {
    const wsUrl = `ws://${formatHostForUrl(host)}:${port}`;
    const ws = new WebSocket(wsUrl, { maxPayload: 2 * 1024 * 1024 });
    let settled = false;
    let sent = false;

    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // ignore close failures during probe
      }
      resolve(ok);
    };

    const sendConnect = (): void => {
      if (sent) return;
      sent = true;
      const params = {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: 'gateway-client',
          version: 'dev',
          platform: process.platform,
          mode: 'backend',
          instanceId: 'fly-gateway-probe'
        },
        role: 'operator',
        scopes: ['operator.admin'],
        caps: ['tool-events'],
        commands: [],
        permissions: {},
        auth: {
          token: gatewayToken
        },
        userAgent: 'pinai-telegram-bot',
        locale: 'en-US'
      };

      ws.send(
        JSON.stringify({
          type: 'req',
          id: CONNECT_PROBE_REQUEST_ID,
          method: 'connect',
          params
        })
      );
    };

    const timeout = setTimeout(() => finish(false), 5000);
    timeout.unref();

    ws.on('open', () => {
      sendConnect();
    });

    ws.on('message', (raw) => {
      let payload: unknown;
      try {
        payload = JSON.parse(String(raw));
      } catch {
        return;
      }

      if (!payload || typeof payload !== 'object') return;
      const data = payload as Record<string, unknown>;
      if (data.type === 'res' && data.id === CONNECT_PROBE_REQUEST_ID) {
        clearTimeout(timeout);
        finish(Boolean(data.ok));
      }
    });

    ws.on('close', () => {
      clearTimeout(timeout);
      finish(false);
    });

    ws.on('error', () => {
      clearTimeout(timeout);
      finish(false);
    });
  });

export const waitForGatewayHello = async (
  host: string,
  port: number,
  gatewayToken: string,
  timeoutMs: number
): Promise<boolean> => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const ok = await probeGatewayHelloOnce(host, port, gatewayToken);
    if (ok) return true;
    await sleep(1000);
  }
  return false;
};

export const waitForHttpReady = async (
  host: string,
  port: number,
  path: string,
  timeoutMs: number
): Promise<boolean> => {
  const startedAt = Date.now();
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = `http://${formatHostForUrl(host)}:${port}${normalizedPath}`;

  while (Date.now() - startedAt < timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    timer.unref();
    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal
      });
      clearTimeout(timer);
      if (response.status >= 100 && response.status < 600) {
        return true;
      }
    } catch {
      clearTimeout(timer);
      // retry until timeout
    }
    await sleep(1000);
  }
  return false;
};
