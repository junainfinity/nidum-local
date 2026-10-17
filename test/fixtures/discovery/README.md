# Discovery and network fixtures (N2)

Inputs for the parser tests in `test/discovery.test.js` and `test/network.test.js`.
User name replaced by `ada`; MAC addresses replaced by `02:00:00:00:00:NN`. Private
LAN addresses (192.168.x) are kept.

## Captured on this Mac (macOS 27.0.1, 2026-10-15, non-root)

| File | Command |
| --- | --- |
| `darwin-lsof-listen.txt` | `lsof -nP -iTCP -sTCP:LISTEN -F pcuLn` (root-owned listeners such as the Portless proxy on :80 are invisible) |
| `darwin-lsof-listen-typed.txt` | `lsof -nP -iTCP -sTCP:LISTEN -F pcuLnt` (what `listListeners()` runs: adds `tIPv4`/`tIPv6`) |
| `darwin-route-default.txt` | `route -n get default` (wired `en11`) |
| `darwin-route-none.txt` | `route -n get default -ifscope lo0` → "not in table" (the same text macOS prints with no default route; exit status is 0) |
| `darwin-ipconfig-summary-ethernet.txt` | `ipconfig getsummary en11` (`InterfaceType : Ethernet`) |
| `darwin-ipconfig-summary-wifi-off.txt` | `ipconfig getsummary en0` with Wi-Fi off (`Active : FALSE`, no SSID) |
| `darwin-networksetup-airport-off.txt` | `networksetup -getairportnetwork en0` with Wi-Fi off |
| `darwin-networksetup-hardwareports.txt` | `networksetup -listallhardwareports` |
| `http-plex-401.html` | Body of `GET /` on Plex Media Server :32400 (401, `<title>Unauthorized</title>`), captured 2026-10-15 |

## Hand-written from captured formats

| File | Based on |
| --- | --- |
| `darwin-lsof-ipv6-noproc.txt` | Real `-F pcuLnt` output of a Node process bound to `::1`, `0.0.0.0`, `::` and `127.0.0.1`, plus invented process sets with no `c`/`L` fields (pid 4120 with only `u0`, pid 4121 with nothing), a link-local `[fe80::1%lo0]` bind and a specific LAN bind |
| `darwin-lsof-cwd.txt` | Shape of `lsof -a -d cwd -Fn -p <pids>` (real output for pid 701 and a node pid; paths invented) |
| `darwin-ps-command.txt` | Shape of `ps -ww -o pid=,command= -p <pids>` incl. the `\012` newline escape ps prints |
| `darwin-ipconfig-summary-wifi-on.txt` | The real Wi-Fi summary with `SSID`, `BSSID`, `Addresses` and `InterfaceType : WiFi` as printed when associated |
| `darwin-ipconfig-summary-wifi-redacted.txt` | Same, with `SSID : <redacted>` as macOS 14.4+ prints without location permission |
| `darwin-networksetup-airport-on.txt`, `…-not-associated.txt` | Documented `networksetup` messages |
| `darwin-route-default-utun.txt` | The real `route -n get default` with the route through a VPN tunnel: `interface: utun4`, no `gateway:` line, no `GATEWAY` flag, MTU 1380 |

## Hand-written (not run here: no Linux or Windows on this machine)

| File | Source of the format |
| --- | --- |
| `linux-ss-with-p.txt` | `ss -ltnpH` (iproute2 6.x) as root: `users:(("name",pid=N,fd=N))`, several owners on one socket, `%lo` scope, `[::ffff:…]` |
| `linux-ss-without-p.txt` | `ss -ltnpH` as a non-root user for sockets of other users (no `users:` column) |
| `linux-ip-route-get*.txt` | `ip route get 1.1.1.1` connected via Wi-Fi / Ethernet, and the "Network is unreachable" error |
| `linux-nmcli-wifi*.txt` | `nmcli -t -f ACTIVE,SSID dev wifi list --rescan no` (`\:` escaping) and empty output with the radio off |
| `windows-listeners*.json` | Output of the PowerShell script in `src/discovery.js` (`Get-NetTCPConnection` + `Get-Process` → `ConvertTo-Json -Compress`), incl. the single-object (not array) case |
| `windows-listeners-ps51.json`, `windows-network-ps51.json` | Windows PowerShell 5.1 shape where `ConvertTo-Json` wraps arrays held in `[pscustomobject]` properties as `{"value":[…],"Count":n}` (the scripts also run `Remove-TypeData System.Array` to avoid it) |
| `windows-network-wireguard.json`, `…-tailscale.json`, `…-anyconnect.json` | Default route through a VPN adapter (WireGuard `wg-office` / "WireGuard Tunnel", Tailscale "Tailscale Tunnel", Cisco AnyConnect "Virtual Miniport Adapter" reporting `802.3`) next to a Wi-Fi/Ethernet adapter with a private address |
| `windows-network-*.json` | Output of the PowerShell script in `src/network.js` (`Get-NetRoute`, `Get-NetAdapter`, `Get-NetIPAddress`) |
| `windows-netsh-wlan-*.txt` | `netsh wlan show interfaces` (English): connected, radio off, no wireless interface |
| `http-nginx-404.html` | nginx's default 404 page (`<title>404 Not Found</title>`) |
| `http-error-pages.json` | Status + title pairs for the "title is only a status phrase" rule: Go/Express/Django/Google-style error titles (→ `null`) and real titles on error responses (kept) |
