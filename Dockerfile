FROM debian:trixie-slim AS build

WORKDIR /app
COPY package.json ./

RUN apt-get update \
    && apt-get install -y --no-install-recommends nodejs npm \
    && npm install \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

FROM debian:trixie-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        powertop \
        nodejs \
        curl \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY package.json server.js ./
COPY public/ ./public/
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["/entrypoint.sh"]
