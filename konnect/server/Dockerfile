FROM node:22-slim

WORKDIR /app

# Install build deps for better-sqlite3 (native module)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copy relay server
COPY konnect/server/package.json konnect/server/package-lock.json* ./konnect/server/
WORKDIR /app/konnect/server
RUN npm ci --production

# Copy source files
WORKDIR /app
COPY konnect/ ./konnect/
COPY public/ ./public/

EXPOSE 3000
ENV NODE_ENV=production

CMD ["node", "konnect/server/index.js"]
