#!/usr/bin/env bash
set -euo pipefail

export DISPLAY="${DISPLAY:-:1}"
resolution="${COKE_DESKTOP_RESOLUTION:-1440x900}"
start_url="${COKE_DESKTOP_START_URL:-https://example.com}"
chrome_bin="${COKE_DESKTOP_CHROME_BIN:-/usr/bin/chromium}"
mkdir -p "$HOME" "$HOME/.config/chromium" "$HOME/.vnc" /workspace/.coke-desktop /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix

Xvfb "$DISPLAY" -screen 0 "${resolution}x24" -ac +extension GLX +render -noreset >/tmp/dots-xvfb.log 2>&1 &
xvfb_pid=$!
xfce_pid=""; vnc_pid=""; websockify_pid=""; chrome_pid=""; worker_pid=""; agent_pid=""
cleanup() {
  trap - EXIT INT TERM
  kill "$xvfb_pid" "$xfce_pid" "$vnc_pid" "$websockify_pid" "$chrome_pid" "$worker_pid" "$agent_pid" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

for _ in $(seq 1 50); do
  xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 && break
  sleep 0.2
done
xdpyinfo -display "$DISPLAY" >/dev/null 2>&1

dbus-launch --exit-with-session startxfce4 >/tmp/dots-xfce.log 2>&1 &
xfce_pid=$!
vnc_password="${VNC_PASSWORD:-}"
if [[ "${COKE_DESKTOP_VNC_AUTH_MODE:-gateway}" == "password" ]]; then
  [[ -n "$vnc_password" ]] || { echo "VNC_PASSWORD is required in password mode" >&2; exit 1; }
  x11vnc -storepasswd "$vnc_password" "$HOME/.vnc-passwd" >/dev/null
  x11vnc -display "$DISPLAY" -rfbauth "$HOME/.vnc-passwd" -rfbport 5900 -forever -shared -noxdamage >/tmp/dots-vnc.log 2>&1 &
else
  # The authenticated Dots API proxies the noVNC stream. The Service never
  # exposes the raw VNC listener directly.
  x11vnc -display "$DISPLAY" -nopw -localhost -rfbport 5900 -forever -shared -noxdamage >/tmp/dots-vnc.log 2>&1 &
fi
vnc_pid=$!
websockify --web=/usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900 >/tmp/dots-websockify.log 2>&1 &
websockify_pid=$!

chrome_flags=(
  --disable-dev-shm-usage --disable-gpu --no-first-run --no-default-browser-check
  --password-store=basic --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222
  --user-data-dir="$HOME/.config/chromium" --start-maximized
)
if [[ "${COKE_DESKTOP_CHROME_NO_SANDBOX:-0}" == "1" ]]; then chrome_flags+=(--no-sandbox); fi
"$chrome_bin" "${chrome_flags[@]}" "$start_url" >/tmp/dots-chrome.log 2>&1 &
chrome_pid=$!
node /opt/coke-dots/computer-worker.mjs >/tmp/dots-worker.log 2>&1 &
worker_pid=$!
node /opt/coke-dots/agent-runtime.mjs >/tmp/dots-agent-runtime.log 2>&1 &
agent_pid=$!

while true; do
  for pid in "$xfce_pid" "$vnc_pid" "$websockify_pid" "$worker_pid" "$agent_pid"; do
    kill -0 "$pid" 2>/dev/null || { echo "desktop component exited" >&2; exit 1; }
  done
  if ! kill -0 "$chrome_pid" 2>/dev/null; then
    "$chrome_bin" "${chrome_flags[@]}" "$start_url" >>/tmp/dots-chrome.log 2>&1 &
    chrome_pid=$!
  fi
  sleep 5
done
