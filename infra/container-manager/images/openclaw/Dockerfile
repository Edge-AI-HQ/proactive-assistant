FROM node:22-slim

# Install desktop environment + VNC dependencies
RUN apt-get update && apt-get install -y \
    git \
    python3 \
    build-essential \
    xvfb \
    x11vnc \
    xfce4 \
    xfce4-terminal \
    dbus-x11 \
    firefox-esr \
    chromium \
    wget \
    curl \
    net-tools \
    && rm -rf /var/lib/apt/lists/*

# Install TigerVNC (替代 KasmVNC，更稳定)
RUN apt-get update && apt-get install -y \
    tigervnc-standalone-server \
    tigervnc-common \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g openclaw@2026.2.25

# Install Playwright for browser automation
RUN npm install -g playwright@latest && \
    npx playwright install --with-deps chromium && \
    npx playwright install ffmpeg && \
    mv /root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome /root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome-bin && \
    printf '#!/bin/sh\nexec "$(dirname "$0")/chrome-bin" --no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage "$@"\n' > /root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome && \
    chmod +x /root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome

WORKDIR /app

RUN mkdir -p /opt/pinai/plugins/telegram-router-proxy
COPY openclaw-plugins/telegram-router-proxy/ /opt/pinai/plugins/telegram-router-proxy/

# Setup VNC directories and browser configs
RUN mkdir -p /root/.vnc /app/data/vnc /etc/chromium.d /root/.mozilla/firefox && \
    echo 'export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --no-sandbox --disable-dev-shm-usage"' > /etc/chromium.d/default-flags && \
    echo 'user_pref("browser.cache.disk.enable", false);' > /root/.mozilla/firefox/prefs.js && \
    echo 'user_pref("browser.cache.memory.enable", true);' >> /root/.mozilla/firefox/prefs.js

VOLUME /app/config
VOLUME /app/data

ENV OPENCLAW_MODE="headless"
ENV OPENCLAW_GATEWAY_PORT="18789"
ENV OPENAI_API_KEY=""
ENV ELEVENLABS_API_KEY=""
ENV OPENCLAW_TELEGRAM_ROUTER_PLUGIN_PATH="/opt/pinai/plugins/telegram-router-proxy"
ENV VNC_PORT="8444"
ENV DISPLAY=":1"
# Playwright default browser args for container environment
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="/root/.cache/ms-playwright/chromium-1208/chrome-linux/chrome"
ENV PLAYWRIGHT_BROWSERS_PATH="/root/.cache/ms-playwright"

EXPOSE 18789 8444

CMD ["openclaw", "gateway", "--bind", "lan"]
