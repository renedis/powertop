# PowerTop 2.15 with WebGUI
Powertop in a container and a Node.JS web service that serves the html report. Auto-generates (html report) and refreshes every 60 seconds.

It pulls the latest version from Debian Trixie and supports MultiArch. Reports are generated in container location "/tmp/powertop/report.html"

Docker run example:
```
docker run --rm -it \
  --privileged \
  --pid=host \
  -v /sys:/sys \
  -v /DATA/AppData/powertop:/tmp/powertop \
  -p 3000:3000 \
  renedis/powertop:latest
```

Compose example:
```
name: powertop-webgui
services:
    powertop:
        stdin_open: true
        tty: true
        privileged: true
        pid: host
        volumes:
            - /sys:/sys
            - /DATA/AppData/powertop:/tmp/powertop
        ports:
            - 3000:3000
        image: renedis/powertop:latest
```
