const esc = (v: unknown): string =>
  String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

export const renderGoogleManagePage = (params: {
  telegramUserId: number;
  statusText: string;
  connected: boolean;
  scopes: string;
  updatedAt: string;
  email?: string | null;
}): string => {
  const telegramUserId = String(params.telegramUserId);
  const statusText = esc(params.statusText);
  const scopes = esc(params.scopes || '-');
  const updatedAt = esc(params.updatedAt || '-');
  const email = esc(params.email || '-');
  const connectHref = `/oauth/google/start?telegram_user_id=${encodeURIComponent(telegramUserId)}&next=/google/manage?telegram_user_id=${encodeURIComponent(telegramUserId)}`;

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Google Workspace CLI Manager</title>
    <style>
      body { font-family: ui-sans-serif, system-ui; max-width: 720px; margin: 32px auto; padding: 0 16px; color: #111827; }
      .card { border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
      .row { margin: 8px 0; }
      .actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
      button, a.btn { border: none; border-radius: 8px; padding: 10px 14px; font-weight: 600; cursor: pointer; text-decoration: none; display: inline-block; }
      .primary { background: #111827; color: #fff; }
      .danger { background: #dc2626; color: #fff; }
      .ghost { background: #f3f4f6; color: #111827; }
      code { background: #f9fafb; padding: 2px 6px; border-radius: 6px; }
    </style>
  </head>
  <body>
    <h2>Google Workspace CLI Manager</h2>
    <p>本页用于本地测试 Google 授权与 gws 凭据下发（Telegram 用户维度）。</p>

    <div class="card">
      <div class="row"><strong>telegram_user_id:</strong> <code>${telegramUserId}</code></div>
      <div class="row"><strong>连接状态:</strong> ${statusText}</div>
      <div class="row"><strong>Email:</strong> <code>${email}</code></div>
      <div class="row"><strong>Scopes:</strong> <code>${scopes}</code></div>
      <div class="row"><strong>更新时间:</strong> ${updatedAt}</div>
      <div class="actions">
        <a class="btn primary" href="${connectHref}">连接 Google</a>
        <button id="disconnectBtn" class="danger">断开授权</button>
        <button id="syncBtn" class="ghost">下发 gws 凭据到容器</button>
      </div>
    </div>

    <script>
      const telegramUserId = ${JSON.stringify(telegramUserId)};
      const onAction = async (url, method) => {
        const res = await fetch(url, {
          method,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ telegram_user_id: Number(telegramUserId) })
        });
        const text = await res.text();
        let payload;
        try { payload = JSON.parse(text); } catch { payload = { message: text || 'unknown' }; }
        if (!res.ok) {
          alert('失败: ' + (payload.error || payload.message || res.status));
          return;
        }
        alert(payload.message || 'ok');
        location.reload();
      };

      document.getElementById('disconnectBtn').addEventListener('click', () => {
        onAction('/google/api/disconnect', 'POST');
      });
      document.getElementById('syncBtn').addEventListener('click', () => {
        onAction('/google/api/sync', 'POST');
      });
    </script>
  </body>
</html>`;
};

export const renderGoogleCallbackPage = (params: {
  title: string;
  message: string;
  email?: string | null;
  botUrl?: string | null;
}): string => {
  const title = esc(params.title);
  const message = esc(params.message);
  const email = esc(params.email || '');
  const botUrl = params.botUrl?.trim() || '';
  const autoRedirectScript = botUrl
    ? `<script>setTimeout(() => { window.location.href = ${JSON.stringify(botUrl)}; }, 1200);</script>`
    : '';
  const botButton = botUrl
    ? `<a href="${esc(botUrl)}" style="display:inline-block;background:#111827;color:#fff;text-decoration:none;padding:10px 14px;border-radius:8px;font-weight:600;">Return to Telegram</a>`
    : '';

  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>${title}</title>
    </head>
    <body style="font-family:ui-sans-serif,system-ui;max-width:720px;margin:40px auto;padding:16px;line-height:1.6;color:#111827;">
      <h2>${title}</h2>
      <p>${message}</p>
      ${email ? `<p><strong>Connected mailbox:</strong> <code>${email}</code></p>` : ''}
      <p>You can now ask your assistant to:</p>
      <ul>
        <li>Show your latest emails</li>
        <li>Search emails by keyword or sender</li>
        <li>Summarize unread emails</li>
        <li>Highlight emails that need a reply</li>
      </ul>
      ${botButton}
      ${autoRedirectScript}
    </body>
  </html>`;
};
