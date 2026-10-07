# Coke Dots Mac demo tunnel

Public address: `https://codex.cokeagent.com/dots-demo/`.

The demo keeps the application, SQLite data, OAuth credentials, and Linux desktop control on the Mac. A persistent OpenSSH reverse forward binds to `127.0.0.1:14317` on the VPS and forwards to `127.0.0.1:14318` on the Mac. `GatewayPorts no` keeps the forwarded port private to the VPS. Nginx proxies only `/dots-demo/` to that loopback port; it does not add a listener, change DNS/TLS, or route any other application path.

## Mac process

Create `~/Library/Application Support/Coke Dots Demo/demo.env` with mode `0600`. Keep this file outside the repository. Required public-route settings:

```dotenv
DOTS_PORT=14318
DOTS_BASE_PATH=/dots-demo
DOTS_DATA_DIR=/Users/<mac-user>/Library/Application Support/Coke Dots Demo/data
DOTS_PUBLIC_HOST=codex.cokeagent.com
DOTS_PUBLIC_ORIGIN=https://codex.cokeagent.com
DOTS_APP_URL=https://codex.cokeagent.com/dots-demo
DOTS_TRUSTED_PROXY_TOKEN=<random 64-character hex value>
GOOGLE_REDIRECT_URI=https://codex.cokeagent.com/dots-demo/auth/google/callback
```

Add the Google OAuth client ID and secret to this file before enabling sign-in. The authorized redirect URI must exactly match the callback above. The demo uses its own data directory and must not point at `./data` or another Coke Dots installation.

Run `sync-demo-app.sh` after `npm run build:demo`; it copies only `src`, `dist`, `node_modules`, and `package.json` into the private Application Support runtime so macOS background processes do not need access to the `Documents` checkout. Then install `com.coke.dots.demo.plist` as `~/Library/LaunchAgents/com.coke.dots.demo.plist`. It restarts the server if it exits. Logs go to `~/Library/Logs/coke-dots-demo.*.log`.

## Reverse tunnel

Copy the existing VPS key to `~/Library/Application Support/Coke Dots Demo/vps-tunnel.pem` with mode `0600`. Install `com.coke.dots.demo-tunnel.plist` as `~/Library/LaunchAgents/com.coke.dots.demo-tunnel.plist`. It runs:

```sh
ssh -N -T -R 127.0.0.1:14317:127.0.0.1:14318 ubuntu@119.29.119.26
```

Use the existing Coke Codex VPS key, `BatchMode`, `ExitOnForwardFailure`, and SSH keepalives. The Mac-side key path is referenced by the LaunchAgent; no new VPS package or firewall rule is needed.

## Nginx scope and rollback

In the active HTTPS server block for `codex.cokeagent.com`, add the exact `/dots-demo` redirect and the `^~ /dots-demo/` reverse proxy before the existing `location /` fallback. The proxy must overwrite `X-Dots-Proxy-Token` with the same random local secret, preserve the request URI, pass WebSocket upgrade headers, and disable response buffering for SSE. Do not add the route to the port 80 server block.

Before editing, back up `/etc/nginx/sites-enabled/coke-openrouter` outside `sites-enabled`; verify that it is still the active regular file. Run `sudo nginx -t` before reloading. Verify the public Dots HTML and prefixed JS/CSS MIME, the login/API path, the noVNC WebSocket only after a user has signed in and opened a desktop, and existing `/app/`, `/router/`, and `/sandbox/` responses.

Rollback only unloads the two Mac LaunchAgents, removes the two `/dots-demo` locations from the backed-up active Nginx file, runs `sudo nginx -t`, and reloads Nginx. It must not restart the VPS or touch any existing app, K3D resource, route, certificate, DNS record, or data directory.
