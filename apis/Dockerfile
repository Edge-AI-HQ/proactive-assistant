FROM node:20-alpine

WORKDIR /app

# Copy root package files
COPY package*.json ./

# Copy workspace package files
COPY apis/package*.json ./apis/

# Install all dependencies
RUN npm ci

# Copy apis source (types are now inside apis/src/types)
COPY apis ./apis

# Build the API
RUN npm run build --workspace @pin-ai/apis

# Expose port
EXPOSE 3000

# Start the application
WORKDIR /app/apis
CMD ["node", "dist/src/server.js"]
