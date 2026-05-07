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

ARG VITE_API_BASE_URL
ARG VITE_PIN_API_URL
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY

ENV VITE_API_BASE_URL=$VITE_API_BASE_URL \
    VITE_PIN_API_URL=$VITE_PIN_API_URL \
    VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY

# The repo's lockfile lives at the project root, not under
# proactive-ai-frontend/. Building frontend in isolation here means we
# don't get a deterministic install — accept `npm install` for now.
# Long-term: switch to a pnpm workspace build that copies the root
# lockfile in (out of scope for this consolidation).
COPY package.json ./
RUN npm install --no-audit --no-fund --legacy-peer-deps

COPY . .
RUN npm run build

# ── Stage 2: runtime ──
FROM nginx:1.27-alpine

# SPA at the root path (vite `base: "/"`).
#   /                  → index.html
#   /assets/...        → hashed JS/CSS, immutable cache
#   /api/*, /health    → reverse-proxied to pinai-agents web (same-origin
#                        from the browser's POV, so no CORS preflight)
#   /<anything else>   → SPA fallback to index.html (React Router)
#
# Upstream is hard-coded to the docker-compose service name `pinai-web`.
# On fly.io the frontend image is rebuilt with this swapped to whatever
# the agents app's internal hostname is (e.g. proactive-ai-agents-dev.internal).
COPY <<'EOF' /etc/nginx/conf.d/default.conf
resolver 127.0.0.11 ipv6=off valid=10s;

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

    # /api/* — reverse proxy to pinai-agents web. Same-origin from the
    # browser, so no CORS preflight + the Authorization header rides
    # straight through.
    #
    # `proxy_buffering off` is required for /api/chat-stream/send SSE so
    # tokens stream to the browser in real time instead of stalling in
    # nginx's response buffer. Long read/send timeouts cover multi-minute
    # agent turns (Daytona sandbox + LLM tool calls).
    location /api/ {
        proxy_pass http://pinai-web:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_request_buffering off;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }

    # /health — backend liveness probe used by lib/api.ts probeBackendHealth.
    location = /health {
        proxy_pass http://pinai-web:8000/health;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
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
