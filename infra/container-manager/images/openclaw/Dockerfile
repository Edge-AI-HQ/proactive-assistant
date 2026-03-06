FROM node:22-slim

# Install basic dependencies
RUN apt-get update && apt-get install -y \
    git \
    python3 \
    build-essential \
    wget \
    curl \
    net-tools \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g openclaw@2026.3.2 @googleworkspace/cli
RUN rm -f /usr/local/bin/gog && rm -rf /usr/local/lib/node_modules/openclaw/skills/gog

WORKDIR /app

RUN mkdir -p /opt/pinai/plugins/telegram-router-proxy
COPY openclaw-plugins/telegram-router-proxy/ /opt/pinai/plugins/telegram-router-proxy/
COPY infra/container-manager/images/openclaw/skills/ /usr/local/lib/node_modules/openclaw/skills/

VOLUME /app/config
VOLUME /app/data

ENV OPENCLAW_MODE="headless"
ENV OPENCLAW_GATEWAY_PORT="18789"
ENV OPENAI_API_KEY=""
ENV ELEVENLABS_API_KEY=""
ENV OPENCLAW_TELEGRAM_ROUTER_PLUGIN_PATH="/opt/pinai/plugins/telegram-router-proxy"

EXPOSE 18789

CMD ["openclaw", "gateway", "--bind", "lan"]
