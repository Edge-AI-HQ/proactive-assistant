import { serve } from 'bun';
import postgres from 'postgres';

// 配置
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET!;
const DATABASE_URL = process.env.DATABASE_URL!;
const OPENCLAW_TELEGRAM_WEBHOOK_PORT = Number.parseInt(
  process.env.OPENCLAW_TELEGRAM_WEBHOOK_PORT || '8787',
  10
);
const OPENCLAW_TELEGRAM_WEBHOOK_PATH = process.env.OPENCLAW_TELEGRAM_WEBHOOK_PATH || '/telegram-webhook';
const FLY_APP_NAME = process.env.OPENCLAW_FLY_APP_NAME || 'pinclaw-api-dev';
const OPENCLAW_FALLBACK_PORT = Number.parseInt(process.env.OPENCLAW_GATEWAY_PORT || '18789', 10);

// 初始化数据库连接
const sql = postgres(DATABASE_URL);

console.log('🚀 Telegram Router starting...');
console.log('📡 Bot Token:', TELEGRAM_BOT_TOKEN ? '✓' : '✗');
console.log('🔐 Webhook Secret:', WEBHOOK_SECRET ? '✓' : '✗');
console.log('💾 Database:', DATABASE_URL ? '✓' : '✗');

serve({
  port: process.env.PORT || 3001,
  async fetch(req) {
    const url = new URL(req.url);
    console.log(`📥 ${req.method} ${url.pathname}`);

    // Health check
    if (url.pathname === '/health') {
      return new Response('OK', { status: 200 });
    }

    // Telegram webhook 入口
    if (url.pathname === '/webhook/telegram' && req.method === 'POST') {
      return handleTelegramWebhook(req);
    }

    // Telegram API 代理（供 OpenClaw 发送消息）
    if (url.pathname.startsWith('/api/telegram/')) {
      return handleTelegramApiProxy(req, url);
    }

    return new Response('Not Found', { status: 404 });
  }
});

async function handleTelegramWebhook(req: Request) {
  try {
    // 验证 webhook secret
    const secretToken = req.headers.get('X-Telegram-Bot-Api-Secret-Token');
    if (secretToken !== WEBHOOK_SECRET) {
      console.error('❌ Invalid webhook secret');
      return new Response('Unauthorized', { status: 401 });
    }

    const update = await req.json();

    const chatId = extractChatId(update);
    const fromUser = extractUpdateFromUser(update);
    const text = extractUpdateText(update);
    const telegramDate = extractUpdateDate(update);
    const nowIso = new Date().toISOString();
    console.log(
      `📨 inbound ts=${nowIso} tg_time=${formatUnixTimestamp(telegramDate)} ` +
      `update_id=${update?.update_id ?? 'n/a'} chat_id=${chatId ?? 'n/a'} ` +
      `user=${fromUser ?? 'unknown'} text="${truncateForLog(text, 160)}"`
    );

    if (!chatId) {
      console.log('⚠️  No chat_id found in update');
      return jsonResponse({ ok: true });
    }

    // 查询用户对应的容器
    const container = await findUserContainer(chatId);

    if (!container) {
      console.log(`❌ No container found for chat_id: ${chatId}`);
      // 发送引导消息
      await sendTelegramMessage(chatId,
        '👋 Welcome! Please create your assistant first.\n\nUse /create_claw_assistant to get started.'
      );
      return jsonResponse({ ok: true });
    }

    console.log(`✅ Found container:`, container);

    // 转发到 OpenClaw 容器
    await forwardToOpenClaw(container, update);

    return jsonResponse({ ok: true });

  } catch (error) {
    console.error('❌ Webhook error:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}

async function handleTelegramApiProxy(req: Request, url: URL) {
  try {
    // 提取 Telegram API 方法
    const method = url.pathname.replace('/api/telegram/', '');
    const traceId = `tgapi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const reqMethod = req.method.toUpperCase();
    const hasBody = reqMethod !== 'GET' && reqMethod !== 'HEAD';
    const body = hasBody ? new Uint8Array(await req.arrayBuffer()) : undefined;
    const bodyInfo = extractTelegramProxyBodyInfo(url, req.headers.get('content-type'), body);
    const container = bodyInfo.chatId ? await findUserContainer(bodyInfo.chatId) : null;
    const runtime = container?.container_id ? parseFlyRuntimeRef(container.container_id) : null;
    const sourceHint = req.headers.get('fly-client-ip')
      || req.headers.get('x-forwarded-for')
      || req.headers.get('x-real-ip')
      || 'unknown';

    console.log(
      `🔄 Proxying Telegram API [${traceId}] method=${method} chat_id=${bodyInfo.chatId ?? 'n/a'} ` +
      `machine_id=${runtime?.machineId ?? 'unknown'} runtime_ref=${container?.container_id ?? 'unknown'} ` +
      `source=${sourceHint} content_type=${bodyInfo.contentType} body_bytes=${body?.byteLength ?? 0}`
    );

    // 转发到 Telegram API
    const telegramUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}${url.search}`;
    const outgoingHeaders = new Headers();
    const contentType = req.headers.get('content-type');
    if (contentType) {
      outgoingHeaders.set('content-type', contentType);
    }
    const response = await fetch(telegramUrl, {
      method: reqMethod,
      headers: outgoingHeaders,
      body: body
    });

    const result = new Uint8Array(await response.arrayBuffer());
    const responseMeta = parseTelegramApiResponseMeta(response, result);
    console.log(
      `✅ Telegram API response [${traceId}] status=${response.status} ok=${responseMeta.ok ?? 'n/a'} ` +
      `result_message_id=${responseMeta.resultMessageId ?? 'n/a'} ` +
      `result_chat_id=${responseMeta.resultChatId ?? 'n/a'} ` +
      `description=${responseMeta.description ?? 'n/a'}`
    );

    return new Response(result, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('content-type') || 'application/json'
      }
    });

  } catch (error) {
    console.error('❌ Telegram API proxy error:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}

function extractChatId(update: any): number | null {
  return (
    update.message?.chat?.id ||
    update.callback_query?.from?.id ||
    update.channel_post?.chat?.id ||
    null
  );
}

function extractUpdateFromUser(update: any): string | null {
  const from = update.message?.from || update.callback_query?.from || update.channel_post?.from;
  if (!from) return null;
  return from.username || from.first_name || from.last_name || String(from.id || '');
}

function extractUpdateText(update: any): string {
  return (
    update.message?.text ||
    update.channel_post?.text ||
    update.callback_query?.data ||
    ''
  );
}

function extractUpdateDate(update: any): number | undefined {
  const dateValue = update.message?.date || update.channel_post?.date || update.callback_query?.message?.date;
  return parseNumeric(dateValue);
}

function formatUnixTimestamp(unixSec?: number): string {
  if (!unixSec) return 'n/a';
  try {
    return new Date(unixSec * 1000).toISOString();
  } catch {
    return 'n/a';
  }
}

function truncateForLog(value: string, maxLen: number): string {
  if (!value) return '';
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLen) return compact;
  return `${compact.slice(0, maxLen)}...`;
}

async function findUserContainer(chatId: number) {
  try {
    const result = await sql`
      SELECT
        a.id as assistant_id,
        a.assistant_bot_id,
        a.assistant_bot_username,
        r.runtime_provider,
        r.runtime_ref,
        r.host_port,
        r.status,
        u.gateway_token
      FROM assistants a
      LEFT JOIN runtime_instances r
        ON r.assistant_id = a.id
        AND r.scope = 'assistant'
      JOIN users u ON a.owner_user_id = u.id
      WHERE u.telegram_user_id = ${chatId}
        AND r.status = 'running'
      ORDER BY a.id
      LIMIT 1
    `;

    if (result.length === 0) {
      return null;
    }

    return {
      container_id: result[0].runtime_ref,
      gateway_token: result[0].gateway_token,
      assistant_bot_id: result[0].assistant_bot_id,
      runtime_provider: result[0].runtime_provider
    };

  } catch (error) {
    console.error('Database query error:', error);
    return null;
  }
}

async function forwardToOpenClaw(container: any, update: any) {
  try {
    // 解析 Fly machine runtime ref
    const runtime = parseFlyRuntimeRef(container.container_id);
    if (!runtime?.machineId) {
      console.error(`Invalid container_id: ${container.container_id}`);
      return;
    }

    // 同时尝试 runtime_ref 私网 IPv6 与 machine DNS，兼容 Fly 内网路由差异
    const hostCandidates = [
      ...(runtime.privateIp ? [runtime.privateIp] : []),
      `${runtime.machineId}.vm.${FLY_APP_NAME}.internal`
    ];
    const candidateUrls = buildWebhookCandidateUrls(hostCandidates);

    console.log(`🎯 Forwarding candidates:`);
    candidateUrls.forEach((url) => console.log(`   - ${url}`));
    console.log(`   Machine ID: ${runtime.machineId}`);
    if (runtime.privateIp) {
      console.log(`   Private IP: ${runtime.privateIp}`);
    }
    console.log(`   Provider: ${container.runtime_provider}`);
    let lastError: unknown = null;

    for (const webhookUrl of candidateUrls) {
      try {
        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET
          },
          body: JSON.stringify(update),
          signal: AbortSignal.timeout(20000)
        });

        if (response.ok) {
          console.log(`✅ Forwarded successfully via ${webhookUrl}`);
          return;
        }

        const text = await response.text();
        if (response.status === 404 || response.status === 405) {
          console.warn(`⚠️  Endpoint not accepted (${response.status}) at ${webhookUrl}, trying next`);
          continue;
        }

        console.error(`❌ Forward failed at ${webhookUrl}: ${response.status} - ${text}`);
        return;
      } catch (error) {
        lastError = error;
        const errName = (error as { name?: string } | null)?.name || '';
        if (errName === 'TimeoutError' && webhookUrl.includes(':8787/')) {
          console.log(`✅ Forward accepted (timeout) via ${webhookUrl}`);
          return;
        }
        console.warn(`⚠️  Forward connect error at ${webhookUrl}, trying next`);
      }
    }

    console.error('❌ Forward failed on all candidate endpoints', lastError);

  } catch (error) {
    console.error('❌ Forward error:', error);
  }
}

function buildWebhookCandidateUrls(targetHosts: string[]): string[] {
  const path = normalizeWebhookPath(OPENCLAW_TELEGRAM_WEBHOOK_PATH);
  const urls: string[] = [];
  targetHosts.forEach((host) => {
    const urlHost = formatHostForUrl(host);
    urls.push(
      `http://${urlHost}:${OPENCLAW_TELEGRAM_WEBHOOK_PORT}${path}`,
      `http://${urlHost}:${OPENCLAW_FALLBACK_PORT}${path}`,
      `http://${urlHost}:${OPENCLAW_FALLBACK_PORT}/telegram-webhook`,
      `http://${urlHost}:${OPENCLAW_FALLBACK_PORT}/webhook/telegram`
    );
  });
  return [...new Set(urls)];
}

function normalizeWebhookPath(value: string): string {
  const trimmed = (value || '').trim();
  if (!trimmed) return '/telegram-webhook';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function parseFlyRuntimeRef(runtimeRef: string): { machineId: string; privateIp?: string } | null {
  if (!runtimeRef) return null;
  if (!runtimeRef.startsWith('fly:')) {
    return { machineId: runtimeRef };
  }

  const payload = runtimeRef.slice(4);
  const [machineId, privateIpRaw] = payload.split('|', 2);
  if (!machineId) return null;
  const privateIp = privateIpRaw?.trim();
  return privateIp ? { machineId, privateIp } : { machineId };
}

function formatHostForUrl(host: string): string {
  if (!host.includes(':')) return host;
  return host.startsWith('[') ? host : `[${host}]`;
}

function extractTelegramProxyBodyInfo(
  url: URL,
  contentType: string | null,
  body?: Uint8Array
): { chatId?: number; contentType: string } {
  const normalizedType = (contentType || '').toLowerCase();
  let chatId: number | undefined;

  if (url.searchParams.has('chat_id')) {
    chatId = parseNumeric(url.searchParams.get('chat_id'));
  }

  if (!body || body.byteLength === 0) {
    return { chatId, contentType: normalizedType || 'none' };
  }

  const bodyText = decodeUtf8(body);
  if (!bodyText) {
    return { chatId, contentType: normalizedType || 'binary' };
  }

  if (normalizedType.includes('application/json')) {
    try {
      const parsed = JSON.parse(bodyText) as Record<string, unknown>;
      const maybeChatId = parseNumeric(parsed.chat_id);
      if (maybeChatId !== undefined) {
        chatId = maybeChatId;
      }
    } catch {}
    return { chatId, contentType: normalizedType };
  }

  if (normalizedType.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(bodyText);
    const maybeChatId = parseNumeric(params.get('chat_id'));
    if (maybeChatId !== undefined) {
      chatId = maybeChatId;
    }
    return { chatId, contentType: normalizedType };
  }

  if (normalizedType.includes('multipart/form-data')) {
    const maybeChatId = parseMultipartChatId(bodyText);
    if (maybeChatId !== undefined) {
      chatId = maybeChatId;
    }
    return { chatId, contentType: normalizedType };
  }

  return { chatId, contentType: normalizedType || 'text' };
}

function parseTelegramApiResponseMeta(
  response: Response,
  body: Uint8Array
): { ok?: boolean; resultMessageId?: number; resultChatId?: number; description?: string } {
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    return {};
  }

  const text = decodeUtf8(body);
  if (!text) {
    return {};
  }

  try {
    const parsed = JSON.parse(text) as {
      ok?: boolean;
      description?: string;
      result?: { message_id?: number; chat?: { id?: number } };
    };
    return {
      ok: parsed.ok,
      resultMessageId: parseNumeric(parsed.result?.message_id),
      resultChatId: parseNumeric(parsed.result?.chat?.id),
      description: parsed.description
    };
  } catch {
    return {};
  }
}

function parseMultipartChatId(raw: string): number | undefined {
  const marker = 'name="chat_id"';
  const idx = raw.indexOf(marker);
  if (idx < 0) return undefined;
  const tail = raw.slice(idx + marker.length);
  const match = tail.match(/\r?\n\r?\n([\-0-9]+)/);
  if (!match) return undefined;
  return parseNumeric(match[1]);
}

function parseNumeric(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function decodeUtf8(data: Uint8Array): string | undefined {
  try {
    return new TextDecoder().decode(data);
  } catch {
    return undefined;
  }
}

async function sendTelegramMessage(chatId: number, text: string) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    });
  } catch (error) {
    console.error('Send message error:', error);
  }
}

function jsonResponse(data: any) {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' }
  });
}

console.log('✅ Telegram Router listening on http://localhost:3001');
