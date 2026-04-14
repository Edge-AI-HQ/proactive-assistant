FROM node:20-alpine

WORKDIR /app

# ── Layer 1: Dependencies (rarely changes) ──
COPY package*.json ./
COPY apis/package*.json ./apis/
COPY proactive-ai-frontend/package*.json ./proactive-ai-frontend/
RUN npm ci

# ── Layer 2: Frontend build (changes less often than APIs) ──
# VITE_* vars are baked into the JS bundle at build time.
# Pass via fly.toml [build.args] or --build-arg.
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ARG VITE_API_BASE_URL
COPY proactive-ai-frontend ./proactive-ai-frontend
COPY scripts/sync-skills-manifest.mjs ./scripts/
RUN npm run build --workspace @pin-ai/proactive-ai-frontend

# ── Layer 3: APIs source + build (changes most often — last) ──
COPY apis ./apis
RUN npm run build --workspace @pin-ai/apis

# ── Layer 4: dotenvx for runtime secret decryption ──
RUN apk add --no-cache curl && curl -sfS https://dotenvx.sh/install.sh | sh

# Copy encrypted .env files (decrypted at runtime via DOTENV_PRIVATE_KEY_*)
COPY apis/.env.dev apis/.env.production ./apis/

EXPOSE 3000
WORKDIR /app/apis

# DEPLOY_ENV selects which .env file to decrypt at startup (dev or production).
# The matching DOTENV_PRIVATE_KEY_* must be set as a Fly secret.
ARG DEPLOY_ENV=dev
ENV DEPLOY_ENV=${DEPLOY_ENV}
CMD ["sh", "-c", "exec dotenvx run -f .env.${DEPLOY_ENV} --overload -- node dist/src/server.js"]
