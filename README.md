# PowerTop 2.15 with WebGUI
Powertop in a container and a Node.JS web service that serves the html report. Auto-generates (html report) and refreshes every 60 seconds.

It pulls the latest version from Debian Trixie and supports MultiArch.

```
docker run --rm -it \
  --privileged \
  --pid=host \
  -v /sys:/sys \
  -p 3000:3000 \
  renedis/powertop:latest
```
