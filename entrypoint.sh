#!/bin/bash
set -e

mkdir -p /tmp/powertop

while true; do
    powertop --html=/tmp/powertop/report.html --time=20 2>/dev/null || true
    sleep 40
done &

exec node /app/server.js
