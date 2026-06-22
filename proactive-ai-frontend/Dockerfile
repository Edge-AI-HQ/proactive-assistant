# proactive-ai-frontend — static SPA served by nginx on Fly.
#
# Multi-stage:
#   1. node20-slim — npm ci + vite build (produces dist/).
#   2. nginx:alpine — copy dist/ + a minimal config that does SPA routing
#      (history-mode fallback to index.html).
#
# Build-time VITE_* args are baked into the bundle. Set them via
# fly.frontend.toml [[build.args]] (in dev) or `flyctl deploy --build-arg`
# (one-off). Production should use fly secrets-as-build-args via CI.

FROM node:20-slim AS builder
WORKDIR /app

ARG WORKDIR=.
ARG VITE_PIN_API_URL
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY

ENV VITE_PIN_API_URL=$VITE_PIN_API_URL \
    VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY

COPY ${WORKDIR}/package.json ./
COPY capacitor-plugins/ ./capacitor-plugins/
# Point the file: dep at ./capacitor-plugins (same dir as package.json)
# so Node resolution walks up into /app/node_modules/ from there.
# Also strip ambient-ai's prepare:tsc (no tsc in this image) and its
# pre-built dist/ so Vite transpiles the TS sources directly.
RUN node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));p.dependencies['@pin/capacitor-ambient-ai']='file:./capacitor-plugins/ambient-ai';fs.writeFileSync('package.json',JSON.stringify(p,null,2))"
RUN node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('capacitor-plugins/ambient-ai/package.json','utf8'));delete p.scripts.prepare;p.main='src/index.ts';p.types='src/index.ts';fs.writeFileSync('capacitor-plugins/ambient-ai/package.json',JSON.stringify(p,null,2))" && rm -rf capacitor-plugins/ambient-ai/dist
RUN npm install --no-audit --no-fund --legacy-peer-deps --ignore-scripts

COPY ${WORKDIR}/ .
# 共用层源码直引（分层 Phase 0+）：vite alias 把 @pin-ai/core|state 指到
# `__dirname/../packages/*/src`，容器内 __dirname=/app → /packages。包是
# 纯 TS 源码（Vite 直接转译），无各自 install/build 步骤。/node_modules
# symlink 让 /packages/** 里的裸 import（react、@tanstack/*）按 Node
# resolution 向上命中 /app 的依赖树——等价于本地 monorepo 的 root hoisting。
COPY packages/ /packages/
RUN ln -s /app/node_modules /node_modules
RUN npm run build

# ── Stage 2: runtime ──
FROM nginx:1.27-alpine

# SPA at the root path (vite `base: "/"`).
#   /                  → index.html
#   /assets/...        → hashed JS/CSS, immutable cache
#   /api/*, /health    → reverse-proxied to backend web (same-origin
#                        from the browser's POV, so no CORS preflight)
#   /<anything else>   → SPA fallback to index.html (React Router)
#
# Runtime config via nginx:alpine's standard envsubst template
# mechanism (https://github.com/nginxinc/docker-nginx — `templates/`
# is processed at startup by /docker-entrypoint.d/20-envsubst-on-templates.sh).
# One image, three envs — the upstream is a full URL with scheme so
# the same template handles plain-HTTP (compose) and HTTPS-via-fly-proxy
# (fly) without branching:
#   * docker-compose: NGINX_UPSTREAM_URL=http://api:8000,
#                     NGINX_RESOLVER="127.0.0.11 ipv6=off"
#   * fly test/dev/prod: NGINX_UPSTREAM_URL=https://<agents-app>.fly.dev,
#                        NGINX_RESOLVER=[fdaa::3]
#
# Fly path goes through public anycast (rather than 6PN direct) because
# the agents `web` process binds only IPv4 (fly-proxy needs IPv4 for
# same-machine forwarding); 6PN direct would require dual-stack on the
# app side. See backend/fly.test.toml for the bind rationale.
#
# NGINX_ENVSUBST_FILTER restricts substitution to NGINX_* so nginx's own
# $host / $remote_addr / etc. variables are left alone.
ENV NGINX_ENVSUBST_FILTER="^NGINX_"

COPY <<'EOF' /etc/nginx/templates/default.conf.template
resolver ${NGINX_RESOLVER} valid=10s;

server {
    listen 8080;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    # Hashed assets: long cache, no access log noise.
    location /assets/ {
        access_log off;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # /api/* — reverse proxy to backend web. Same-origin from the
    # browser, so no CORS preflight + the Authorization header rides
    # straight through.
    #
    # Host header set to $proxy_host (derived from NGINX_UPSTREAM_URL),
    # not $host, so the upstream fly-proxy sees its own hostname for
    # SNI/routing — the original browser Host (frontend's domain) would
    # not match any backend app and would 404 at fly-proxy.
    # `proxy_ssl_server_name on` + `proxy_ssl_name $proxy_host` makes
    # the TLS handshake send SNI = backend hostname, so fly-proxy picks
    # the right cert and routes to the right app. Both no-ops for the
    # plain-HTTP compose path.
    #
    # `proxy_buffering off` is required for /api/chat-stream/send SSE so
    # tokens stream to the browser in real time instead of stalling in
    # nginx's response buffer. Long read/send timeouts cover multi-minute
    # agent turns (Daytona sandbox + LLM tool calls).
    location /api/ {
        proxy_pass ${NGINX_UPSTREAM_URL};
        proxy_http_version 1.1;
        proxy_set_header Host $proxy_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_ssl_server_name on;
        proxy_ssl_name $proxy_host;
        proxy_buffering off;
        proxy_cache off;
        proxy_request_buffering off;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }

    # /health — backend liveness probe used by lib/api.ts probeBackendHealth.
    location = /health {
        proxy_pass ${NGINX_UPSTREAM_URL}/health;
        proxy_http_version 1.1;
        proxy_set_header Host $proxy_host;
        proxy_ssl_server_name on;
        proxy_ssl_name $proxy_host;
        proxy_read_timeout 10s;
    }

    # SPA fallback: try literal file, then index.html so the React Router
    # resolves unknown paths client-side.
    location / {
        try_files $uri $uri/ /index.html;
        add_header Cache-Control "no-cache, no-store, must-revalidate";
    }
}
EOF

COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
