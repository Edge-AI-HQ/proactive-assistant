FROM node:20-slim AS build

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:20-slim

WORKDIR /app

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/views ./src/views
COPY --from=build /app/public ./public

EXPOSE 3000

CMD ["npm", "start"]
