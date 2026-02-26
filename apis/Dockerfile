FROM node:20-alpine

WORKDIR /app

# Copy root package files
COPY package*.json ./

# Copy workspace package files
COPY apis/package*.json ./apis/
COPY packages/shared-types/package*.json ./packages/shared-types/

# Install all dependencies (including workspaces)
RUN npm ci

# Copy shared-types source and build it first
COPY packages/shared-types ./packages/shared-types
RUN npm run build --workspace @pin-ai/shared-types

# Copy apis source
COPY apis ./apis

# Build the API
RUN npm run build --workspace @pin-ai/apis

# Expose port
EXPOSE 3000

# Start the application
WORKDIR /app/apis
CMD ["node", "dist/src/server.js"]
