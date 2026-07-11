# apps/web — PIN AI 桌面 web 端（zebra 设计），static SPA served by nginx on Fly.
#
# Multi-stage：
#   1. node20-slim — npm install + vite build (produces dist/).
#   2. nginx:alpine — copy dist/ + SPA routing config（/api 反代 backend，
#      same-origin 免 CORS，SSE 不缓冲）。
#
# Build context = repo root（CI: `flyctl deploy . --config apps/web/fly.toml
# --dockerfile apps/web/Dockerfile --build-arg WORKDIR=apps/web`）——packages/
# 共用层（core/state/ui-kit/design）要随 context 进来。

FROM node:20-slim AS builder
WORKDIR /app

ARG WORKDIR=.
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY

ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY

COPY ${WORKDIR}/package.json ./
RUN npm install --no-audit --no-fund --legacy-peer-deps --ignore-scripts

COPY ${WORKDIR}/ .
# 共用层源码直引：vite alias 把 @pin-ai/core|state|ui-kit 指到
# `__dirname/../../packages/*/src`，容器内 __dirname=/app → /packages（
# path.resolve 在根目录封顶）。包是纯 TS 源码（Vite 直接转译），无各自
# install/build 步骤。/node_modules symlink 让 /packages/** 里的裸 import
# （react、@supabase/*、@tanstack/*）按 Node resolution 向上命中 /app 的
# 依赖树——等价于本地 monorepo 的 root hoisting。
COPY packages/ /packages/
RUN ln -s /app/node_modules /node_modules
RUN npm run build

# ── Stage 2: runtime ──
FROM nginx:1.27-alpine

# SPA at the root path (vite `base: "/"`).
#   /                  → index.html
#   /assets/...        → hashed JS/CSS/media, immutable cache
#   /api/*, /health    → reverse-proxied to backend web (same-origin
#                        from the browser's POV, so no CORS preflight)
#   /<anything else>   → SPA fallback to index.html (React Router)
#
# Runtime config via nginx:alpine's standard envsubst template mechanism；
# 同 proactive-ai-frontend/Dockerfile（rationale 见那边注释）：
#   * docker-compose: NGINX_UPSTREAM_URL=http://api:8000,
#                     NGINX_RESOLVER="127.0.0.11 ipv6=off"
#   * fly dev/prod:   NGINX_UPSTREAM_URL=https://<agents-app>.fly.dev,
#                     NGINX_RESOLVER=[fdaa::3]
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

    # /api/* — reverse proxy to backend web. Host/SNI 设为 upstream
    # 自己的 hostname（fly-proxy 路由需要）；`proxy_buffering off` 保 SSE
    # 实时推流；长超时覆盖多分钟 agent turn。
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

    # /health — backend liveness probe.
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
