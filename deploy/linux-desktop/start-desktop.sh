#!/usr/bin/env bash
set -euo pipefail

export DISPLAY="${DISPLAY:-:1}"
resolution="${COKE_DESKTOP_RESOLUTION:-1440x1080}"
screen_width="${resolution%x*}"
screen_height="${resolution#*x}"
browser_width="$((screen_width * 87 / 100))"
browser_height="$((screen_height * 82 / 100))"
browser_x="$(( (screen_width - browser_width) / 2 ))"
browser_y="$(( (screen_height - browser_height) / 2 ))"
start_url="${COKE_DESKTOP_START_URL:-about:blank}"
chrome_bin="${COKE_DESKTOP_CHROME_BIN:-/usr/bin/chromium}"
profile_dir="$HOME/.config/chromium"
mkdir -p "$HOME" "$profile_dir" "$HOME/.vnc" /workspace/.coke-desktop /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix
rm -f /tmp/dots-chrome-startup-ready

# A recreated Pod mounts the prior Pod's persistent Chromium profile. Chrome's
# singleton links include the old Pod name and can block CDP startup forever;
# this entrypoint runs before any Chromium process exists in the new container.
# Drop only process ownership links, keeping cookies, files, and preferences.
rm -f "$profile_dir/SingletonLock" "$profile_dir/SingletonCookie" "$profile_dir/SingletonSocket"

Xvfb "$DISPLAY" -screen 0 "${resolution}x24" -ac +extension GLX +render -noreset >/tmp/dots-xvfb.log 2>&1 &
xvfb_pid=$!
xfce_pid=""; tint2_pid=""; vnc_pid=""; websockify_pid=""; chrome_pid=""; worker_pid=""; agent_pid=""
dbus_pid=""
cleanup() {
  trap - EXIT INT TERM
  kill "$xvfb_pid" "$xfce_pid" "$tint2_pid" "$vnc_pid" "$websockify_pid" "$chrome_pid" "$worker_pid" "$agent_pid" "$dbus_pid" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

for _ in $(seq 1 50); do
  xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 && break
  sleep 0.2
done
xdpyinfo -display "$DISPLAY" >/dev/null 2>&1

eval "$(dbus-launch --sh-syntax)"
dbus_pid="${DBUS_SESSION_BUS_PID:-}"
startxfce4 >/tmp/dots-xfce.log 2>&1 &
xfce_pid=$!
for _ in $(seq 1 50); do
  pgrep -x xfwm4 >/dev/null && break
  sleep 0.2
done
sleep 1
timeout --foreground --kill-after=1s 3s xfce4-panel --quit >/dev/null 2>&1 || true
timeout --foreground --kill-after=1s 3s xfdesktop --quit >/dev/null 2>&1 || true
xsetroot -solid '#ff9b76'
feh --no-fehbg --bg-fill /opt/coke-dots/coral-wallpaper.svg
mkdir -p "$HOME/.config/tint2"
cat >"$HOME/.config/tint2/tint2rc" <<'TINT2_CONFIG'
# Background 1: the translucent rounded dock
rounded = 10
border_width = 1
background_color = #f7eee9 94
border_color = #ffffff 65
panel_items = L
panel_size = 208 48
panel_position = bottom center horizontal
panel_margin = 0 18
panel_padding = 5 3 5
panel_dock = 1
panel_layer = top
panel_background_id = 1
launcher_background_id = 0
launcher_padding = 4 3 4
launcher_icon_size = 34
launcher_tooltip = 1
launcher_item_app = /usr/share/applications/chromium.desktop
launcher_item_app = /usr/share/applications/xfce4-terminal.desktop
launcher_item_app = /usr/share/applications/thunar.desktop
TINT2_CONFIG
tint2 >/tmp/dots-tint2.log 2>&1 &
tint2_pid=$!
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
  --user-data-dir="$HOME/.config/chromium" --load-extension=/opt/coke-dots/chrome-theme --window-position="$browser_x,$browser_y"
  --window-size="$browser_width,$browser_height"
)
if [[ "${COKE_DESKTOP_CHROME_NO_SANDBOX:-0}" == "1" ]]; then chrome_flags+=(--no-sandbox); fi
"$chrome_bin" "${chrome_flags[@]}" "$start_url" >/tmp/dots-chrome.log 2>&1 &
chrome_pid=$!
node /opt/coke-dots/computer-worker.mjs >/tmp/dots-worker.log 2>&1 &
worker_pid=$!
node /opt/coke-dots/agent-runtime.mjs >/tmp/dots-agent-runtime.log 2>&1 &
agent_pid=$!
banner_dismissed=0
for _ in $(seq 1 45); do
  chrome_window="$(xdotool search --onlyvisible --name 'Welcome back, Dot' 2>/dev/null | head -n 1 || true)"
  if [[ -n "$chrome_window" ]] && xdotool getwindowname "$chrome_window" 2>/dev/null | grep -q 'Welcome back, Dot'; then
    timeout --foreground 2s xdotool windowactivate --sync "$chrome_window" || true
    # Chromium shows a native "Installed theme" notice when the tenant's
    # unpacked color theme is first loaded. The local no-sandbox harness also
    # shows a Chromium warning in this same toolbar notice area. Let both
    # settle, then close that area before the welcome desktop is presented.
    sleep 6
    window_geometry="$(xdotool getwindowgeometry --shell "$chrome_window")"
    window_left="$(sed -n 's/^X=//p' <<<"$window_geometry")"
    window_top="$(sed -n 's/^Y=//p' <<<"$window_geometry")"
    window_width_actual="$(sed -n 's/^WIDTH=//p' <<<"$window_geometry")"
    for _ in 1 2 3; do
      xdotool mousemove --sync "$((window_left + window_width_actual - 35))" "$((window_top + 115))"
      xdotool click 1 || true
      sleep 0.5
    done
    xdotool key Escape 2>/dev/null || true
    xdotool mousemove --sync 24 24
    banner_dismissed=1
    break
  fi
  sleep 1
done
[[ "$banner_dismissed" == "1" ]] || echo "Chromium welcome window did not appear before the banner dismissal deadline" >&2
if [[ "$banner_dismissed" == "1" ]]; then touch /tmp/dots-chrome-startup-ready; fi

while true; do
  for pid in "$xfce_pid" "$tint2_pid" "$vnc_pid" "$websockify_pid" "$worker_pid" "$agent_pid"; do
    kill -0 "$pid" 2>/dev/null || { echo "desktop component exited" >&2; exit 1; }
  done
  if ! kill -0 "$chrome_pid" 2>/dev/null; then
    "$chrome_bin" "${chrome_flags[@]}" "$start_url" >>/tmp/dots-chrome.log 2>&1 &
    chrome_pid=$!
  fi
  sleep 5
done
