FROM node:20-alpine

WORKDIR /app

# Copy root package files
COPY package*.json ./

# Copy workspace package files
COPY apis/package*.json ./apis/
COPY miniapp/package*.json ./miniapp/

# Install all dependencies
RUN npm ci

# Copy source for both workspaces
COPY apis ./apis
COPY miniapp ./miniapp
COPY scripts ./scripts

# Build miniapp first (outputs to apis/public/mini/)
RUN npm run build --workspace @pin-ai/miniapp

# Build the API
RUN npm run build --workspace @pin-ai/apis

# Expose port
EXPOSE 3000

# Start the application
WORKDIR /app/apis
CMD ["node", "dist/src/server.js"]
