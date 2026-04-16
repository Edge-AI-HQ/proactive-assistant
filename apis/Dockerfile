# ── Stage 1: Frontend build (isolated, VITE_* scoped here only) ──
FROM node:20-alpine AS frontend

WORKDIR /app

# Install deps (monorepo root + frontend)
COPY package*.json ./
COPY proactive-ai-frontend/package*.json ./proactive-ai-frontend/
COPY apis/package*.json ./apis/
RUN npm ci --workspaces --include-workspace-root

# VITE_* are baked into the JS bundle at build time.
# Pass via fly.toml [build.args], --build-arg, or docker-compose args.
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ARG VITE_API_BASE_URL

COPY proactive-ai-frontend ./proactive-ai-frontend
COPY scripts/sync-skills-manifest.mjs ./scripts/

# Vite outputs to apis/public/proactive/ (configured in vite.config.ts)
RUN VITE_SUPABASE_URL=${VITE_SUPABASE_URL} \
    VITE_SUPABASE_PUBLISHABLE_KEY=${VITE_SUPABASE_PUBLISHABLE_KEY} \
    VITE_API_BASE_URL=${VITE_API_BASE_URL} \
    npm run build --workspace @pin-ai/proactive-ai-frontend

# ── Stage 2: APIs build + runtime ──
FROM node:20-alpine

WORKDIR /app

# Install deps (monorepo root + APIs)
COPY package*.json ./
COPY apis/package*.json ./apis/
RUN npm ci

# Build APIs
COPY apis ./apis
COPY scripts/sync-skills-manifest.mjs ./scripts/
RUN npm run build --workspace @pin-ai/apis

# Copy frontend build artifacts from stage 1 AFTER apis copy.
# This overwrites any stale local apis/public/proactive/ that leaked in.
COPY --from=frontend /app/apis/public/proactive ./apis/public/proactive

# Install dotenvx for runtime secret decryption
RUN apk add --no-cache curl && curl -sfS https://dotenvx.sh/install.sh | sh

# Copy encrypted .env files (decrypted at runtime via DOTENV_PRIVATE_KEY_*)
COPY apis/.env.dev apis/.env.production ./apis/

EXPOSE 3000
WORKDIR /app/apis

# DEPLOY_ENV selects which .env file to decrypt at startup (dev or production).
# The matching DOTENV_PRIVATE_KEY_* must be set as a Fly secret.
ARG DEPLOY_ENV=dev
ENV DEPLOY_ENV=${DEPLOY_ENV}
CMD ["sh", "-c", "exec dotenvx run -f .env.${DEPLOY_ENV} -- node dist/src/server.js"]
