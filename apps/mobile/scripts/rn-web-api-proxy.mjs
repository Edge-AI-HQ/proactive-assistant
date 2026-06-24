#!/usr/bin/env node
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

const target = process.env.PIN_API_TARGET;
const port = Number(process.env.PORT || 8091);

if (!target) {
  console.error("Missing PIN_API_TARGET, for example https://proactive-ai-api-dev.fly.dev");
  process.exit(1);
}

const targetBase = new URL(target);

const hopByHopHeaders = new Set([
  "connection",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "http://localhost:8081",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers":
      "Authorization, Content-Type, X-Dev-Auth, X-Device, X-Run-Id, ngrok-skip-browser-warning",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Expose-Headers": "X-Run-Id",
    Vary: "Origin",
  };
}

function forwardedHeaders(req) {
  const headers = { ...req.headers };
  for (const key of Object.keys(headers)) {
    if (hopByHopHeaders.has(key.toLowerCase())) delete headers[key];
  }
  headers.host = targetBase.host;
  return headers;
}

const server = http.createServer((req, res) => {
  const origin = req.headers.origin;
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(origin));
    res.end();
    return;
  }

  const upstreamUrl = new URL(req.url || "/", targetBase);
  const upstream = https.request(
    upstreamUrl,
    {
      method: req.method,
      headers: forwardedHeaders(req),
    },
    (upstreamRes) => {
      const headers = { ...upstreamRes.headers };
      for (const key of Object.keys(headers)) {
        if (hopByHopHeaders.has(key.toLowerCase())) delete headers[key];
      }
      res.writeHead(upstreamRes.statusCode || 502, {
        ...headers,
        ...corsHeaders(origin),
      });
      upstreamRes.pipe(res);
    },
  );

  upstream.on("error", (err) => {
    res.writeHead(502, {
      "Content-Type": "application/json",
      ...corsHeaders(origin),
    });
    res.end(JSON.stringify({ error: "proxy_error", message: err.message }));
  });

  req.pipe(upstream);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`RN Web API proxy listening on http://127.0.0.1:${port}`);
  console.log(`Forwarding to ${targetBase.origin}`);
});
