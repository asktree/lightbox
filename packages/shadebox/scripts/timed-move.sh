#!/bin/bash
# Move the blind to a position and measure its speed from the lift reports
# in the board log. The blind MOVES: get Iggy's go before a test move.
#
# Usage: timed-move.sh <host> <open-percent> [seconds-to-watch]
#   timed-move.sh shadebox.local 63 17
#
# Reference (2026-10-05, dp 21 = 35): 3.10 %/s up and down.
host="$1"; to="$2"; secs="${3:-24}"
out="$(mktemp)"
start="$(curl -sS -m 4 "http://$host/state" | sed -E 's/.*"up":([0-9]+).*/\1/')"
curl -sS -m 4 -o /dev/null -X POST "http://$host/go?open=$to" || echo "post failed"
sleep "$secs"
curl -sS -m 6 "http://$host/log" | awk -v s="$start" '{ split($1, t, "."); if (t[1] + 0 >= s + 0) print }' > "$out" 2>/dev/null
grep -E 'open=' "$out" | awk '
  { t = $1; raw = $0; sub(/.*raw /, "", raw); sub(/\).*/, "", raw);
    if (raw != last) { n++; ts[n] = t; rs[n] = raw; last = raw } }
  END {
    for (i = 1; i <= n; i++) printf "%s raw %s\n", ts[i], rs[i];
    if (n >= 3) {
      # Skip the first and the last report: the motor ramps up and down there.
      dt = ts[n-1] - ts[2]; dr = rs[n-1] - rs[2]; if (dr < 0) dr = -dr;
      if (dt > 0) printf "speed between report 2 and report %d: %.2f %%/s (%d %% in %.2f s)\n", n-1, dr / dt, dr, dt;
    }
  }'
grep -E 'probe|dp 21 |default response|no ack|send failed' "$out" | tail -n 6
rm -f "$out"
