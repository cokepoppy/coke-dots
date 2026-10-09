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
- The initial cookie-path smoke stopped before account selection; the later token-exchange fix and real Chrome sign-in are recorded below.

## Google token exchange timeout fix

- The user's report of a spinner after Google consent was reproduced from the Mac service logs: OAuth state validation succeeded, but the service's direct connection to `oauth2.googleapis.com:443` timed out. The local HTTP proxy at `127.0.0.1:7890` successfully established outbound HTTPS, while the Coke Dots LaunchAgent had no proxy setting.
- `src/server/auth.ts` now accepts an origin-only `DOTS_GOOGLE_OAUTH_PROXY_URL`, applies it to OAuth HTTP transport, and sets a 15-second request timeout. It disables retries for the one-use authorization-code POST so a timeout or provider error cannot spend the code again. The callback returns the existing visible sign-in error on transport failure.
- The private Mac `demo.env` now sets `DOTS_GOOGLE_OAUTH_PROXY_URL=http://127.0.0.1:7890` with mode `0600`. The app build was synced to the existing private runtime and only `com.coke.dots.demo` was restarted; `com.coke.dots.demo-tunnel` stayed running and no VPS or Nginx configuration was changed.
- Chrome E2E now routes token exchange and ID-token certificate retrieval through a local CONNECT proxy and checks that a simulated 503 returns a visible error with exactly one exchange attempt. `npm run test:e2e` passed all 35 UI steps and the cloud-computer E2E checks; `npm test` passed 53 tests; `npm run test:e2e:public-demo` passed all 6 public route checks.
- A new real Google sign-in was completed in Chrome after the service restart. The public Dots home rendered with the signed-in account and personal workspace, and opening `/dots-demo/api/auth/me` in the same Chrome session returned HTTP 200 with that user's personal tenant. Chrome was returned to the Dots home afterward.
- Re-tested a fresh real Google authorization on 2026-10-07 in a new native Chrome tab. Selecting the existing Google account returned through `/dots-demo/auth/google/callback`; Chrome rendered the authenticated Dots home and personal workspace. The prior tab's one-time authorization code was not replayed.
- `npm run test:e2e` passed the full 36-step Chrome flow, including successful PKCE/token/ID-token/session handling and visible recovery from a mocked token endpoint failure; all 8 Linux cloud-computer checks also passed. `npm test` passed 55 tests, and `npm run test:e2e:public-demo` passed all 6 public Chrome checks.
- The old direct-connect timeout lines in `coke-dots-demo.err.log` were timestamped 17:33 CST; the current `com.coke.dots.demo` process started at 17:42 CST with the proxy-enabled source already synced. The same Google auth client reached the public certificate endpoint through `127.0.0.1:7890` with HTTP 200, while a direct request timed out. A fresh public OAuth flow now completes successfully in Chrome.

## Repeatable browser smoke

Run `npm run test:e2e:public-demo` to check the public redirect, health and auth-config APIs, Chrome-rendered page and prefixed bundles, the enabled Google OAuth redirect, and the expected status/content type for each listed existing route. Set `DOTS_PUBLIC_DEMO_URL` to test another HTTPS Dots base URL. The test requires Google sign-in to be configured and the production E2E fixture to stay disabled. It does not enter account credentials or touch another app's data.

This smoke does not authenticate a Google user, validate OAuth consent, inspect a signed-in tenant, or open the cloud desktop/noVNC socket. The completed real sign-in was a separate manual Chrome acceptance flow; repeat it when OAuth credentials, callback routing, or outbound proxy configuration changes.

## Browser task notifications demo

- Published on 2026-10-09 at `https://codex.cokeagent.com/dots-demo/demos/browser-task-notifications.webp`.
- The animated WebP is 1,152×800, 237 frames, 19.96 seconds at 25 fps, with 1× action playback and four 2.5-second reading pauses. Full decode and Chrome playback with six distinct sampled frames passed. SHA-256: `5b58c3628fed67594673da70985c15d39e60f9263432fae985352d23b9993a0a`.
- Source WebM, screenshots, manifest, and video check are in `artifacts/demos/browser-task-notifications-2026-10-09T01-49-25-787Z/`.
- Publication copies only `public/demos/browser-task-notifications.webp` into the existing Mac demo runtime at `dist/demos/browser-task-notifications.webp`; it does not edit Nginx, the reverse tunnel, or other service files. The public smoke verifies HTTP 200, `image/webp`, full browser playback, and exact local/public byte equality.
- The recording is a Chinese browser-notification walkthrough. Its notification card is a labeled recorder preview; the app's Notification API behavior and click-through are exercised by Chrome E2E, while native macOS notification delivery, Google OAuth, and a live model call are outside this demo's evidence.
- A full public smoke on this date found that the already-hosted `cloud-computer-agent-actions.webp` and `proactive-cloud-computer-followthrough.webp` do not match the latest local recordings. Those two existing clips were left untouched during this notification-only publication. The new notification clip itself returned 200 with the expected type, exact SHA-256, and changing Chrome playback frames.
- To run the public application and browser checks for one clip independently, use `DOTS_PUBLIC_DEMO_VIDEO=browser-task-notifications.webp npm run test:e2e:public-demo`. Without this environment variable the smoke checks all showcase videos.

## Cloud-computer Agent demo playback refresh

- On 2026-10-09, the user said the 17.24-second, 0.5× export still felt too fast. The public cloud-computer clip now plays all recorded actions at 1× and pauses for 2.5 seconds after the computer opens, the public page appears, and the disclosed release time is visible. It retains a 2-second initial state and removes 61.6 seconds of frozen AI waiting. The verified WebP is 1,152×784, 230 decoded frames, and 16.76 seconds; its source and `.video-check.json` report are in `artifacts/demos/cloud-computer-agent-actions-20261009-rerun2/`.
- The combined proactive-to-cloud-computer recording is `https://codex.cokeagent.com/dots-demo/demos/proactive-cloud-computer-followthrough.webp`. The refreshed 955×663 WebP has 749 decoded frames and runs 37.44 seconds. It plays actions at the source's 1× speed, keeps three seconds from both ends of long waits so the resulting UI remains readable, and removes 71.2 seconds of frozen middle footage. The live Pi E2E, source recording, screenshots, and full-decode report are in `artifacts/demos/proactive-release-date-conflict-2026-10-08T19-26-26-795Z/`. The proactive task remains read-only; Pi operates the cloud computer only after the user assigns a separate follow-up task.
- The cloud-computer action log must omit an initial `about:blank` inspection because it has no host to record; the previous placeholder `current page` violated strict hostname validation even when the public navigation and click succeeded. The live E2E also keeps the release-date confirmation chat-only, since “record this decision” can trigger an unrelated Scratchpad approval under the account rule.
- `npm run test:e2e:public-demo` verifies duration, frame count, Chrome playback, and byte-for-byte equality between each locally verified and publicly hosted WebP. The public deployment must return HTTP 200 with `image/webp`. Publishing these files uses the existing `/dots-demo/` reverse-tunnel path and does not change VPS Nginx or other service routes.
