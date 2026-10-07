# Public demo operational evidence

Checked 2026-10-07 against the current Mac and `https://codex.cokeagent.com/`. This is deployment evidence for Coke Dots, not evidence about OpenAI Dots.

## Mac runtime

- `launchctl list` reported both `com.coke.dots.demo` and `com.coke.dots.demo-tunnel` running.
- The demo Node process listened on `127.0.0.1:14318`. Its environment file was `~/Library/Application Support/Coke Dots Demo/demo.env`, mode `0600`, with a separate demo data directory and `/dots-demo` base path.
- The SSH process used the existing VPS key and a reverse forward bound to VPS loopback. No public listener or new firewall rule was added for the forwarded port.
- The OAuth client ID and secret were empty in the demo environment. The browser therefore showed “登录暂未开放”; authenticated Google login has not been tested.
- Secret values, proxy-token values, and private key contents are intentionally omitted.

## Public route checks

Unauthenticated HTTPS GETs returned these results:

| Path | Status | Content type / behavior |
| --- | ---: | --- |
| `/dots-demo/` | 200 | HTML; opened in Chrome and rendered the login-disabled state |
| `/dots-demo/api/health` | 200 | JSON |
| `/dots-demo/api/auth/config` | 200 | JSON |
| `/auth/` | 200 | HTML after redirect |
| `/router/` | 200 | HTML |
| `/app/` | 200 | HTML |
| `/block-crush/` | 200 | HTML |
| `/rpg/` | 200 | HTML |
| `/fish-sort/` | 200 | HTML |
| `/sandbox/` | 200 | HTML |
| `/finance-gateway/` | 401 | JSON; authentication remains required |
| `/web-research-gateway/` | 401 | JSON; authentication remains required |
| `/assets/`, `/home/`, `/downloads/` | 403 | HTML; directory listing remains denied |
| `/` | 200 | HTML |

The read-only SSH inspection confirmed `/etc/nginx/sites-enabled/coke-openrouter` was a regular file and had the Dots path route alongside the existing locations. The active file was not modified during this check.

## Repeatable browser smoke

Run `npm run test:e2e:public-demo` to check the public redirect, health and auth-config APIs, Chrome-rendered page and prefixed bundles, and the expected status/content type for each listed existing route. Set `DOTS_PUBLIC_DEMO_URL` to test another HTTPS Dots base URL. The test does not follow the Google login link or touch another app's data. It adapts to either configured or unconfigured Google login and requires the production E2E fixture to stay disabled.

This smoke does not authenticate a Google user, validate OAuth consent, inspect a signed-in tenant, or open the cloud desktop/noVNC socket. Those require their own authorized acceptance flow.
