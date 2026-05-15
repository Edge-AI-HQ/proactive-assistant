# internal-reward-dashboard — static SPA served by nginx on Fly.
#
# Build-time VITE_SUPABASE_* args are baked into the Vite bundle. Runtime
# nginx proxies /api/* to pinai-agents so the browser keeps a same-origin API
# surface and the Supabase Authorization header can pass through unchanged.

FROM node:20-slim AS builder
WORKDIR /app

ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ARG VITE_REWARD_API_URL

ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY \
    VITE_REWARD_API_URL=$VITE_REWARD_API_URL

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

FROM nginx:1.27-alpine

ENV NGINX_ENVSUBST_FILTER="^NGINX_"

COPY <<'EOF' /etc/nginx/templates/default.conf.template
resolver ${NGINX_RESOLVER} valid=10s;

server {
    listen 8080;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    location /assets/ {
        access_log off;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

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

    location = /health {
        proxy_pass ${NGINX_UPSTREAM_URL}/health;
        proxy_http_version 1.1;
        proxy_set_header Host $proxy_host;
        proxy_ssl_server_name on;
        proxy_ssl_name $proxy_host;
        proxy_read_timeout 10s;
    }

    location / {
        try_files $uri $uri/ /index.html;
        add_header Cache-Control "no-cache, no-store, must-revalidate";
    }
}
EOF

COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]

