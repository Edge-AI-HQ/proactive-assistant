FROM node:20-alpine

WORKDIR /app

# ── Layer 1: Dependencies (rarely changes) ──
COPY package*.json ./
COPY apis/package*.json ./apis/
COPY proactive-ai-frontend/package*.json ./proactive-ai-frontend/
RUN npm ci

# ── Layer 2: Frontend build (changes less often than APIs) ──
COPY proactive-ai-frontend ./proactive-ai-frontend
COPY scripts/sync-skills-manifest.mjs ./scripts/
RUN npm run build --workspace @pin-ai/proactive-ai-frontend

# ── Layer 3: APIs source + build (changes most often — last) ──
COPY apis ./apis
RUN npm run build --workspace @pin-ai/apis

EXPOSE 3000
WORKDIR /app/apis
CMD ["node", "dist/src/server.js"]
