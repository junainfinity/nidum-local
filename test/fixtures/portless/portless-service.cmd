@echo off
set "PORTLESS_STATE_DIR=C:\Users\example\.portless"
set "PORTLESS_PORT=443"
set "PORTLESS_HTTPS=1"
set "PORTLESS_LAN=0"
set "PORTLESS_WILDCARD=0"
set "USERPROFILE=C:\Users\example"
set "PATH=C:\Program Files\nodejs"
"C:\Program Files\nodejs\node.exe" "C:\Users\example\AppData\Roaming\npm\node_modules\portless\dist\cli.js" "proxy" "start" "--foreground" "--port" "443" "--https" "--skip-trust"
