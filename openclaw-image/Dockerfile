FROM node:22-slim

RUN apt-get update && apt-get install -y \
    git \
    python3 \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g openclaw@latest

WORKDIR /app

VOLUME /app/config
VOLUME /app/data

ENV OPENCLAW_API_KEY="***REMOVED***"
ENV OPENCLAW_MODE="headless"
ENV OPENCLAW_GATEWAY_PORT="18789"

EXPOSE 18789

CMD ["openclaw", "gateway", "--bind", "lan"]
