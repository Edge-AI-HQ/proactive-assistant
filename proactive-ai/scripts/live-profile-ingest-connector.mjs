#!/usr/bin/env node
/**
 * Live test: POST profile/connector-ingest on the local OpenClaw gateway.
 * Uses **gateway auth** (`/proactive-ai/api/...`) — same Bearer as Electron logs
 * (`[main] Token: ...`). Composio + Gmail must already be ACTIVE.
 *
 *   PROACTIVE_AI_BASE_URL=http://127.0.0.1:<port> \\
 *   PROACTIVE_AI_GW_TOKEN=<uuid from Electron console> \\
 *   node scripts/live-profile-ingest-connector.mjs --toolkit gmail --apply
 *
 * Defaults: --toolkit gmail, dry-run (omit --apply to preview patch only).
 * Raw tool payloads: subagent should use `pin profile connector-raw append`.
 * With `apply:true` and `--toolkit`, the gateway also runs a **host fallback**
 * (Composio identity → `connector_raw_data` + `connector.<tk>.*` facts) if the
 * subagent returns no legacy JSON patch — restart OpenClaw/Electron after upgrading
 * the plugin so this path is active.
 */

function parseArgs(argv) {
  let toolkit = "gmail";
  let apply = false;
  let maxRecords = 50;
  let base =
    process.env.PROACTIVE_AI_BASE_URL?.replace(/\/+$/, "") ?? "";
  let token = process.env.PROACTIVE_AI_GW_TOKEN?.trim() ?? "";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") apply = true;
    else if (a === "--toolkit" && argv[i + 1]) {
      toolkit = String(argv[++i]).trim().toLowerCase();
    } else if (a === "--max-records" && argv[i + 1]) {
      maxRecords = Math.min(200, Math.max(1, parseInt(argv[++i], 10) || 50));
    } else if (a === "--base-url" && argv[i + 1]) {
      base = String(argv[++i]).replace(/\/+$/, "");
    } else if (a === "--token" && argv[i + 1]) {
      token = String(argv[++i]).trim();
    }
  }
  return { toolkit, apply, maxRecords, base, token };
}

const { toolkit, apply, maxRecords, base, token } = parseArgs(process.argv.slice(2));

if (!base) {
  console.error(
    "Missing base URL. Example:\n  PROACTIVE_AI_BASE_URL=http://127.0.0.1:53560 PROACTIVE_AI_GW_TOKEN=<token> node scripts/live-profile-ingest-connector.mjs --toolkit gmail",
  );
  process.exit(2);
}

if (!token) {
  console.error(
    "Missing gateway token (Electron console: [main] Token: ...). Example:\n  PROACTIVE_AI_GW_TOKEN=<uuid> node scripts/live-profile-ingest-connector.mjs --base-url http://127.0.0.1:53560",
  );
  process.exit(2);
}

const url = new URL("/proactive-ai/api/profile/connector-ingest", `${base}/`);

const body = JSON.stringify({
  toolkit,
  maxRecords,
  apply,
});

const res = await fetch(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  },
  body,
});

const text = await res.text();
let parsed;
try {
  parsed = JSON.parse(text);
} catch {
  parsed = text;
}

console.log(JSON.stringify({ status: res.status, ok: res.ok, body: parsed }, null, 2));

if (!res.ok) process.exit(1);
