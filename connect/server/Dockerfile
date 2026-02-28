FROM node:22-slim

WORKDIR /app

# Install build deps for better-sqlite3 (native module)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copy relay server
COPY connect/server/package.json connect/server/package-lock.json* ./connect/server/
WORKDIR /app/connect/server
RUN npm ci --production

# Copy source files
WORKDIR /app
COPY connect/ ./connect/
COPY public/ ./public/

EXPOSE 3000
ENV NODE_ENV=production

CMD ["node", "connect/server/index.js"]
