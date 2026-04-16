#!/usr/bin/env bash
# Network diagnostics. Tells you what's flaky about your WiFi / LAN and why.
#
# Usage:
#   ./diagnostics.sh [extra_target_ip ...]
#
# Auto-detects your Mac's interface, router, and Hue bridge (if mDNS-findable).
# Add any additional IPs to test as arguments.

set -u

say()  { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
warn() { printf '\033[1;33m⚠ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
bad()  { printf '\033[1;31m✗ %s\033[0m\n' "$*"; }


# ---- Which interface is active? ----
say "Active network interface"

primary_iface=$(route -n get default 2>/dev/null | awk '/interface:/ {print $2}')
if [[ -z "${primary_iface:-}" ]]; then
  bad "No default route — are you online?"
  exit 1
fi

hwport=$(networksetup -listallhardwareports | awk -v i="$primary_iface" '
  /Hardware Port/ {hp=$0}
  /Device:/ && $2==i {print hp; exit}
' | sed 's/Hardware Port: //')

echo "  Using: $primary_iface ($hwport)"

is_wifi=false
[[ "$hwport" == *Wi-Fi* ]] && is_wifi=true

# ---- WiFi details ----
if $is_wifi; then
  say "Wi-Fi details"
  AIRPORT=/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport
  if [[ -x "$AIRPORT" ]]; then
    "$AIRPORT" -I 2>/dev/null | awk '/SSID|BSSID|channel|RSSI|noise|lastTxRate|maxRate/'
  else
    # Fallback for macOS 15+ where airport is gone
    if command -v wdutil >/dev/null 2>&1; then
      echo "(run with sudo for full wdutil output)"
      sudo -n wdutil info 2>/dev/null | awk '
        /SSID|BSSID|Channel|RSSI|Noise|Tx Rate|Rx Rate|Security/
      ' || echo "  (need sudo for detailed WiFi info — run: sudo $0)"
    fi
    networksetup -getairportnetwork "$primary_iface" 2>/dev/null
  fi
fi

# ---- Interface errors ----
say "Interface packet errors (look for non-zero Ierrs/Oerrs)"
# -b (bytes), -I iface, -n (numeric)
netstat -I "$primary_iface" -b 2>/dev/null | awk '
  NR==1 {print; next}
  /Link/ && !seen { print; seen=1 }
'

# Quick current stats
echo
echo "  Current per-interface:"
ifconfig "$primary_iface" | awk '
  /status:/ || /media:/ || /inet / {print "   ", $0}
'

# ---- Build target list ----
TARGETS=()
router=$(route -n get default 2>/dev/null | awk '/gateway:/ {print $2}')
[[ -n "${router:-}" ]] && TARGETS+=("${router}|router")

# Find Hue bridge via SSDP/mDNS (it advertises as _hue._tcp.local)
hue_ip=$(dns-sd -B _hue._tcp 2>/dev/null &
         BG=$!; sleep 1.5; kill $BG 2>/dev/null
         # The above prints instance names; better to use the discovery endpoint
         true)
# Fallback: check if there's a known Hue IP on the LAN via N-UPnP
hue_ip=$(curl -s --max-time 2 https://discovery.meethue.com 2>/dev/null | \
          python3 -c "import sys,json
try:
    d=json.load(sys.stdin)
    print(d[0]['internalipaddress'])
except: pass
" 2>/dev/null)
[[ -n "${hue_ip:-}" ]] && TARGETS+=("${hue_ip}|hue bridge")

# Internet reference
TARGETS+=("1.1.1.1|internet (cloudflare)")

# Command-line extras
for ip in "$@"; do
  TARGETS+=("${ip}|extra")
done

# ---- Ping each target ----
say "Ping tests (10 packets @ 200ms interval each)"
printf "  %-22s %-8s %-10s %-10s %s\n" "target" "loss" "avg_ms" "jitter_ms" "status"
printf "  %-22s %-8s %-10s %-10s %s\n" "------" "----" "------" "---------" "------"

for target in "${TARGETS[@]}"; do
  ip="${target%%|*}"
  name="${target#*|}"
  label=$(printf "%s (%s)" "$name" "$ip")

  result=$(ping -c 10 -i 0.2 -W 1000 "$ip" 2>/dev/null | tail -2)
  if [[ -z "$result" ]]; then
    printf "  %-22s %-8s %-10s %-10s %s\n" "$label" "?" "?" "?" "unreachable"
    continue
  fi
  loss=$(  echo "$result" | awk -F',' '/packet loss/ {gsub("%","",$3); gsub(" ","",$3); print $3+0}')
  stats=$(echo "$result" | awk -F'=' '/round-trip/ {print $2}')
  avg=$(   echo "$stats" | awk -F'/' '{print $2+0}')
  stddev=$(echo "$stats" | awk -F'/' '{print $4+0}')

  # Verdict
  status="${color:-}"
  if   [[ "${loss%.*}" -ge 5 ]];       then verdict="BAD (loss)";
  elif (( $(echo "$avg > 50" | bc -l 2>/dev/null || echo 0) )); then verdict="SLOW";
  elif (( $(echo "$stddev > 20" | bc -l 2>/dev/null || echo 0) )); then verdict="JITTERY";
  else verdict="ok"
  fi
  printf "  %-22s %-8s %-10s %-10s %s\n" "$label" "${loss}%" "${avg}" "${stddev}" "$verdict"
done

# ---- Nearby WiFi channels (detect congestion) ----
if $is_wifi && [[ -x "$AIRPORT" ]]; then
  say "Nearby WiFi (channel congestion)"
  echo "  (look for crowded channels — switch your router to a quieter one)"
  "$AIRPORT" -s 2>/dev/null | awk 'NR==1 || NR<=15' | sed 's/^/  /'
fi

# ---- Summary / interpretation ----
say "Interpretation"
echo "  Good LAN: <1% loss, <5ms avg, <3ms jitter to router."
echo "  Marginal: 1-5% loss, 5-20ms avg, 5-15ms jitter."
echo "  Bad     : >5% loss OR >20ms avg OR >20ms jitter on LAN."
echo
echo "  Fixes if it's bad:"
echo "    - Switch to 5GHz band (if 2.4GHz is crowded)"
echo "    - Move closer to router / move router away from microwaves, walls, cordless phones"
echo "    - Change router WiFi channel to one unused nearby (Airport scan above shows neighbors)"
echo "    - Ethernet if even feasible"
