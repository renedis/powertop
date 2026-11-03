# PowerTop Web Dashboard

PowerTOP in a container with a web dashboard for Linux hosts: live power from RAPL counters and smart plugs, history, idle-state and device reports, and tunables you can apply, exclude and measure.

- Live package, core, DRAM and platform power from RAPL (`/sys/class/powercap`), read every 5 seconds
- Wall power and other readings from MQTT, for example zigbee2mqtt smart plugs, with device discovery
- Adaptive measuring: powertop runs every minute while someone has the page open and every 15 minutes otherwise
- History of power, CPU use, wakeups and deep idle residency (7 days by default)
- Tunables: apply one or a selection, auto-tune with an exclude list, wake-on toggles
- Impact tests: measure power before and after a change, with powertop held so it does not skew the result
- Several hosts in one page: list other instances and switch between them
- Multi-arch image (amd64, arm64); works on kernels without perf events (for example ARM routers), with the views that need perf data hidden

## Quick start

```bash
docker run -d \
  --name powertop \
  --restart unless-stopped \
  --privileged \
  --pid=host \
  -e TZ=Etc/UTC \
  -v /sys:/sys \
  -v /opt/powertop/data:/data \
  -p 9002:3000 \
  renedis/powertop:latest
```

Then open `http://<host>:9002`.

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
      - TZ=Etc/UTC
      - MQTT_URL=mqtt://192.168.1.10:1883
      - WALL_TOPIC=zigbee2mqtt/Server plug
    volumes:
      - /sys:/sys
      - /opt/powertop/data:/data
    ports:
      - "9002:3000"
```

On a router or any host where a sleeping device could cut you off, add `TUNING_ENABLED=false`. The tunables stay visible but cannot be applied, and the setting cannot be switched on from the page.

## Requirements

- `--privileged` and `--pid=host`: powertop reads hardware counters and process names of the host.
- `/sys` bind-mounted: idle states, RAPL, device runtime PM and the tunables live there.
- Intel package C-states need the `msr` kernel module loaded on the host (`modprobe msr`).
- Kernels without `CONFIG_PERF_EVENTS` (common on ARM appliances) give no software or wakeup data; idle states, devices, tunables and wake sources still work.

## Configuration

Everything can be set on the Settings page. Environment variables give the defaults; once a value is changed on the page, the page wins. `TUNING_ENABLED=false` is the exception: it always wins.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port inside the container |
| `DATA_DIR` | `/data` | Settings, history and impact results (falls back to a mounted `/tmp/powertop` from 1.x) |
| `REPORT_DIR` | `/dev/shm/powertop` | Where powertop writes its HTML report (RAM) |
| `MODE` | `adaptive` | `adaptive`, `continuous`, `ondemand` or `paused` |
| `FAST_INTERVAL` | `60` | Seconds between runs while the page is open (and in continuous mode) |
| `IDLE_INTERVAL` | `900` | Seconds between runs in adaptive mode when nobody watches |
| `MEASURE_SECONDS` | `20` | Length of one powertop measurement |
| `TUNING_ENABLED` | `true` | `false` makes tunables and wake sources read-only |
| `MQTT_URL` | | Broker, for example `mqtt://192.168.1.10:1883` |
| `MQTT_USER`, `MQTT_PASS` | | Broker credentials |
| `MQTT_BASE_TOPIC` | `zigbee2mqtt` | Used for device discovery |
| `WALL_TOPIC`, `WALL_PATH` | `power` | Wall power sensor: topic and JSON field |
| `PEERS` | | Other instances, `name=url,name=url` |
| `HISTORY_DAYS` | `7` | History retention (1 to 31) |

### Measurement modes

Each powertop run traces the system for the measurement time, which raises CPU use and power while it runs. Adaptive mode keeps the numbers fresh while you look and otherwise measures rarely. RAPL and MQTT readings are independent of powertop and continue in every mode.

### Sensors

Add the plug that powers the host as the wall sensor. The Power page then compares wall power with the platform and package counters, and impact tests report the change at the wall. Discovery reads the retained `zigbee2mqtt/bridge/devices` topic. Any topic with a JSON or plain numeric payload works. Nothing is published.

### Impact tests

Select tunables or wake sources and choose Test impact. The test holds powertop, waits a settle period, measures a baseline window, applies the selection, settles again and measures the after window (2 × 30 s settle plus 2 × 3 min by default). Results show the change in wall, platform and package power with the number of samples. Plugs report in steps, so a few plug samples give a rough wall figure; RAPL deltas are precise but only cover the CPU.

### Exclusions

Excluded tunables are skipped by auto-tune. An entry is a sysfs path or a tunable description. A host-level `powertop --auto-tune` (cron or systemd) still applies everything.

## Data and disk writes

The report is written to `/dev/shm` inside the container. History is one line per minute plus one per measurement, appended to `DATA_DIR/history/<date>.ndjson` every 10 minutes and on shutdown.

## API

| Endpoint | Method | Description |
|---|---|---|
| `/api/status` | GET | Availability, last update, runner state, capabilities, host |
| `/api/data` | GET | Full parsed report |
| `/api/summary` | GET | Headline figures |
| `/api/events` | GET | Server-sent events: power samples, runner state, new reports, sensors |
| `/api/measure` | POST | Start a measurement now |
| `/api/power/live` | GET | Last 10 minutes of RAPL samples and wall readings |
| `/api/history?range=1h\|6h\|24h\|7d\|30d` | GET | History |
| `/api/tuning/apply` | POST | Apply tunables or toggle wake items: `{"ids": [...]}` |
| `/api/tuning/auto` | POST | Apply every tunable that is not excluded (`/api/auto-tune` also works) |
| `/api/tuning/exclude` | POST | `{"key": "<path or description>", "exclude": true}` |
| `/api/wake/:id/toggle` | POST | Toggle one wake source |
| `/api/settings` | GET, PUT | Settings (the MQTT password is never returned) |
| `/api/mqtt/status`, `/api/mqtt/discover` | GET | Broker state, zigbee2mqtt devices |
| `/api/impact` | GET, POST, DELETE | Impact test state and results, start `{"ids": [...]}`, cancel |
| `/api/peers`, `/api/peer/:n/...` | GET, any | Other instances and a proxy to their API |

## Development

```bash
npm ci
npm test          # node:test, uses the reports in test/fixtures
npm run dev       # fixture report, simulated RAPL, sandboxed sysfs under .local/
```

## License

GPL-3.0. The bundled fonts (Barlow Semi Condensed, IBM Plex Mono) are under the SIL Open Font License; see `public/fonts`.
