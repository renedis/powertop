#!/bin/bash
set -e

mkdir -p /tmp/powertop

while true; do
    TMP="/tmp/powertop/report.tmp.html"

    powertop --html="$TMP" --time=20 2>/dev/null || true

    if [ -s "$TMP" ]; then
        mv "$TMP" /tmp/powertop/report.html
    fi

    sleep 40
done &

exec node /app/server.js
