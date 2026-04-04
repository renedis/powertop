# PowerTop Web Dashboard

PowerTop in a Docker container with a web UI. Auto-generates reports and refreshes every 60 seconds.

- Multi-arch (amd64/arm64)
- Based on Debian Trixie with PowerTop 2.15
- Tabs: Summary, Software, CPU Idle, CPU Frequency, Device Info, Tuning
- Auto-tune button in the UI
- Shows host OS and hostname (not the container's)
- 100% active devices highlighted in red

## Quick Start

```bash
docker run -d \
  --name powertop \
  --restart unless-stopped \
  --privileged \
  --pid=host \
  -e TZ=Europe/Amsterdam \
  -v /sys:/sys \
  -v /tmp/powertop:/tmp/powertop \
  -p 9002:3000 \
  renedis/powertop:latest
```

Then open `http://<host-ip>:9002`

## Compose

```yaml
services:
  powertop:
    image: renedis/powertop:latest
    container_name: powertop
    restart: unless-stopped
    privileged: true
    pid: host
    environment:
      - TZ=Europe/Amsterdam
    volumes:
      - /sys:/sys
      - /tmp/powertop:/tmp/powertop
    ports:
      - "9002:3000"
```

## Requirements

- `--privileged` and `--pid=host` are required for PowerTop to access hardware counters
- `/sys` must be bind-mounted for power state readings
- Set `TZ` to your timezone for correct report timestamps

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/data` | GET | Full parsed report as JSON |
| `/api/status` | GET | Report availability and last update time |
| `/api/auto-tune` | POST | Run `powertop --auto-tune` |
