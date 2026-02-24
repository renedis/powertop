FROM debian:trixie-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends powertop \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

ENTRYPOINT ["powertop"]
