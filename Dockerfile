FROM debian:trixie-slim

# Installeer powertop, Node.js en benodigdheden
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        powertop \
        nodejs \
        npm \
        curl \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Kopieer Node.js bestanden
COPY package.json ./
RUN npm install

COPY server.js ./
COPY public/ ./public/

# Start script: powertop als achtergrondproces + node webserver
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["/entrypoint.sh"]
