FROM node:20-slim AS build

WORKDIR /app

COPY apps/pinclaw-bot/package.json apps/pinclaw-bot/package-lock.json* ./
RUN npm ci

COPY apps/pinclaw-bot/ ./
RUN mkdir -p /app/public && npm run build && npm prune --omit=dev

FROM node:20-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg poppler-utils \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/views ./src/views
COPY --from=build /app/public ./public

EXPOSE 3000

CMD ["npm", "start"]
