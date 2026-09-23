#!/bin/sh
# pi-better-openai live helper for the Mac (the machine with the microphone).
#
# It keeps ONE SSH ControlMaster connection to the pi host. That connection carries the
# -L forward to the browser audio page. Over the same connection, it reads the live
# state file that `/live` writes on the pi host, and opens the page once for each new
# /live run. The page token goes only from that file to `open`: never over HTTP, never
# into a cache, and never into this helper's output.
#
# Usage: live-mac-helper.sh <ssh-host>
# Environment:
#   PBO_LIVE_PORT      browser audio port on both ends (default 8795; match live.browserPort)
#   PBO_LIVE_INTERVAL  seconds between polls (default 2)
#   PBO_LIVE_POLLS     stop after this many polls (default 0 = run until stopped; for tests)
set -u

host=${1:?usage: live-mac-helper.sh <ssh-host>}
port=${PBO_LIVE_PORT:-8795}
interval=${PBO_LIVE_INTERVAL:-2}
polls=${PBO_LIVE_POLLS:-0}
case $port in '' | *[!0-9]*)
  echo "PBO_LIVE_PORT must be a port number" >&2
  exit 2
  ;;
esac
control="${TMPDIR:-/tmp}/pbo-live-$(id -u)-$port.sock"

# Runs on the pi host. It prints the state only while the pi process that wrote it lives.
remote='f=${XDG_STATE_HOME:-$HOME/.local/state}/pi-better-openai/live.json; [ -r "$f" ] || exit 0; s=$(cat "$f"); p=$(printf "%s" "$s" | sed -n "s/.*\"pid\":\([0-9][0-9]*\).*/\1/p"); [ -n "$p" ] && kill -0 "$p" 2>/dev/null && printf "%s\n" "$s"; exit 0'

master=
cleanup() {
  if [ -n "$master" ]; then kill "$master" 2>/dev/null; fi
}
trap cleanup EXIT
trap 'exit 0' INT TERM

start_master() {
  rm -f "$control"
  ssh -N -M -S "$control" -o ControlPersist=no -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o BatchMode=yes -o LogLevel=QUIET \
    -L "$port:127.0.0.1:$port" "$host" &
  master=$!
}

last=
count=0
wait_s=$interval
while :; do
  if [ -z "$master" ] || ! kill -0 "$master" 2>/dev/null; then
    start_master
  fi
  state=
  # Poll only through a live master: without its socket, ssh would open a new connection.
  if [ -e "$control" ]; then
    state=$(ssh -S "$control" -o ControlMaster=no -o BatchMode=yes -o LogLevel=QUIET \
      "$host" "$remote" 2>/dev/null) || state=
    wait_s=$interval
  elif [ "$wait_s" -lt 60 ]; then
    wait_s=$((wait_s * 2 + 1)) # The host is not reachable; back off up to about a minute.
  fi
  started=$(printf '%s' "$state" | sed -n 's/.*"startedAt":"\([^"]*\)".*/\1/p')
  url=$(printf '%s' "$state" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')
  if [ -n "$started" ] && [ "$started" != "$last" ]; then
    last=$started
    token=${url#"http://localhost:$port/#"}
    if [ "$token" != "$url" ] && [ -n "$token" ] &&
      [ -z "$(printf '%s' "$token" | tr -d 'A-Za-z0-9_-')" ]; then
      if open "$url"; then
        echo "Opened the live page for the /live run started at $started."
      else
        echo "Could not open the live page for the /live run started at $started." >&2
      fi
    else
      echo "Ignored a live state whose URL is not a localhost:$port page URL." >&2
    fi
  fi
  count=$((count + 1))
  if [ "$polls" -gt 0 ] && [ "$count" -ge "$polls" ]; then break; fi
  sleep "$wait_s"
done
