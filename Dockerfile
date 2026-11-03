FROM debian:trixie-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./

RUN apt-get update \
    && apt-get install -y --no-install-recommends nodejs npm ca-certificates \
    && npm ci --omit=dev --no-audit --no-fund \
    && rm -rf /var/lib/apt/lists/* /root/.npm

FROM debian:trixie-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        powertop \
        nodejs \
        curl \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The report lives in RAM; settings and history go to DATA_DIR (default /data).
ENV NODE_ENV=production \
    PORT=3000 \
    REPORT_DIR=/dev/shm/powertop

COPY --from=build /app/node_modules ./node_modules
COPY package.json server.js ./
COPY src/ ./src/
COPY public/ ./public/

EXPOSE 3000

HEALTHCHECK --interval=120s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/api/status" > /dev/null || exit 1

CMD ["node", "/app/server.js"]
