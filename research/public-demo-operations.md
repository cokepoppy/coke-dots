# Public demo operational evidence

Checked 2026-10-07 against the current Mac and `https://codex.cokeagent.com/`. This is deployment evidence for Coke Dots, not evidence about OpenAI Dots.

## Mac runtime

- `launchctl list` reported both `com.coke.dots.demo` and `com.coke.dots.demo-tunnel` running.
- The demo Node process listened on `127.0.0.1:14318`. Its environment file was `~/Library/Application Support/Coke Dots Demo/demo.env`, mode `0600`, with a separate demo data directory and `/dots-demo` base path.
- The SSH process used the existing VPS key and a reverse forward bound to VPS loopback. No public listener or new firewall rule was added for the forwarded port.
- At the initial check, the OAuth client ID and secret were empty in the demo environment. The browser showed “登录暂未开放” at that time. This is a historical snapshot; current login verification is below.
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

## Current login verification

- The public `/dots-demo/api/auth/config` now returns `googleConfigured: true` and `e2eAuthAvailable: false`.
- Chrome renders the “使用 Google 登录” button. Clicking it starts Google OAuth with the registered `/dots-demo/auth/google/callback`, `openid email profile`, PKCE S256, state, and nonce.
- `npm run test:e2e:public-demo` checks that sign-in remains enabled, verifies the state cookie in Chrome, then opens the public callback with the same state and no authorization code. The expected `invalid` response proves the callback accepted its state; `expired` means the cookie or stored flow was missing. The test does not contact Google's token endpoint or complete a real user sign-in.
- Local development now uses the same OAuth client with the separately registered `http://127.0.0.1:4317/auth/google/callback`. Its ignored `.env` file is mode `0600` and remains outside Git.

## OAuth expiry fix

- The reported post-Google “登录请求已过期” came from the state cookie path. `auth.ts` had cached `DOTS_BASE_PATH` while its static import was evaluated, before `index.ts` loaded the protected environment file. The public callback URI included `/dots-demo`, but Chrome had stored the state cookie at `/auth/google/callback`, so it did not send that cookie to the prefixed callback.
- The cookie and application paths are now resolved after environment loading. `tests/auth-env-file.test.ts` starts the server with its base path only in `DOTS_ENV_FILE`; it verifies the OAuth cookie has the prefixed callback path and remains `Secure`, `HttpOnly`, and `SameSite=Lax`.
- The fix was synchronized to the existing private Mac runtime and only the `com.coke.dots.demo` LaunchAgent was restarted. Public Chrome E2E now verifies the cookie at `/dots-demo/auth/google/callback`; all six public smoke checks pass, including the existing service-route probes.
- Start a fresh Google login after this fix. The automated test follows the OAuth redirect and validates Chrome's cookie, but stops before account selection and does not complete a real user sign-in.

## Repeatable browser smoke

Run `npm run test:e2e:public-demo` to check the public redirect, health and auth-config APIs, Chrome-rendered page and prefixed bundles, the enabled Google OAuth redirect, and the expected status/content type for each listed existing route. Set `DOTS_PUBLIC_DEMO_URL` to test another HTTPS Dots base URL. The test requires Google sign-in to be configured and the production E2E fixture to stay disabled. It does not enter account credentials or touch another app's data.

This smoke does not authenticate a Google user, validate OAuth consent, inspect a signed-in tenant, or open the cloud desktop/noVNC socket. Those require their own authorized acceptance flow.
