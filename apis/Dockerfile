FROM node:20-alpine

WORKDIR /app

# Copy root package files
COPY package*.json ./

# Copy workspace package files
COPY apis/package*.json ./apis/
COPY proactive-ai-frontend/package*.json ./proactive-ai-frontend/

# Install all dependencies
RUN npm ci

# Copy source for all workspaces
COPY apis ./apis
COPY proactive-ai-frontend ./proactive-ai-frontend
COPY scripts ./scripts

# Build proactive frontend (outputs to apis/public/proactive/)
RUN npm run build --workspace @pin-ai/proactive-ai-frontend

# Build the API
RUN npm run build --workspace @pin-ai/apis

# Expose port
EXPOSE 3000

# Start the application
WORKDIR /app/apis
CMD ["node", "dist/src/server.js"]
