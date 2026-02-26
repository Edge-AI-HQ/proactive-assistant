FROM node:20-slim AS build

WORKDIR /app

# Copy root package files
COPY package*.json ./

# Copy workspace package files
COPY apps/pinclaw-bot/package*.json ./apps/pinclaw-bot/
COPY packages/shared-types/package*.json ./packages/shared-types/

# Install all dependencies (including workspaces)
RUN npm ci

# Copy shared-types source and build it first
COPY packages/shared-types ./packages/shared-types
RUN npm run build --workspace @pin-ai/shared-types

# Copy bot source
COPY apps/pinclaw-bot ./apps/pinclaw-bot

# Build the bot
RUN npm run build --workspace @pin-ai/pinclaw-bot

# Prune dev dependencies
RUN npm prune --omit=dev

FROM node:20-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg poppler-utils \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/apps/pinclaw-bot/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared-types/src ./node_modules/@pin-ai/shared-types/src
COPY --from=build /app/apps/pinclaw-bot/dist ./dist

RUN mkdir -p /app/public

EXPOSE 3000

CMD ["npm", "start"]
