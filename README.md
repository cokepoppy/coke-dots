# Coke Dots

An evidence-led, local-first personal agent project. Features are developed on separate branches, with observed Dots behavior recorded before implementation.

## Run locally

Requires Node.js 24 or newer. Copy `.env.example` to a local environment file (do not commit OAuth credentials), register a Google OAuth web client, and set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and the exact callback URI `http://127.0.0.1:4317/auth/google/callback`. Then run `npm install` and `npm run dev`, and open `http://127.0.0.1:5173`. Google sign-in requests only OpenID Connect identity, email, and profile scopes.

The model API is configured from a workspace's dot profile. Its API key is stored under that workspace's account in macOS Keychain; model endpoint and name are stored in tenant-scoped SQLite settings. The optional `DOTS_MODEL*` environment settings are retained only for the original local bootstrap workspace.

The background worker and web UI are separate processes. Closing the browser window leaves the worker running. `DOTS_DATA_DIR` defaults to `./data`; the SQLite database is never committed. Starting the server again recovers any task left in `working` state. Without a configured model, tasks explicitly fail and can be retried after configuration.

For the Mac shell, run `npm run desktop`. It builds the web UI, server and Electron wrapper, starts a detached local server if needed, and opens the app. Closing the window leaves that server running. `npm run dev:desktop` runs the UI with Vite. The current shell requires Node.js 24 on the Mac and is a local development build, not a signed installer.

## Automated browser tests

Run `npm test` for the unit suite and `npm run test:e2e` for the Chrome click-through. The browser suite builds the web client, launches a loopback-only service against a fresh temporary SQLite directory, and records viewport screenshots, browser video, Playwright traces, server logs and a JSON manifest under `artifacts/e2e/<run>/`. It needs local Google Chrome; set `DOTS_CHROME_BIN` if Chrome is installed elsewhere.

The suite covers login-screen rendering, three-account isolation, pending workspace invitations and acceptance/revocation, member removal, role controls, persistent tasks and redirection, the paged tenant-scoped Activity log and task navigation, explicit task stop while a model request is running, cancellation of a pending page approval when its task is stopped, explicitly managed workspace memories reaching the model request, tenant-scoped custom rules for Scratchpad writes, pending approval with member review, approve/decline without premature writes, agent-created Scratchpad pages opened from chat, recurring schedules, service-restart recovery, and the computer browser's open/take-over/navigate/click/type/return path. Its sign-in button is a test-only fixture, enabled only when both `NODE_ENV=test` and `DOTS_E2E_AUTH=1`; it accepts only `@example.test` identities and uses the disposable test database. This exercises authenticated product flows without Google secrets, but does not replace a real Google OAuth acceptance test. Local screenshots and recordings document Coke Dots behavior; they are not a pixel comparison against OpenAI Dots. Reference-frame extraction and comparison remain pending in the [evidence ledger](research/README.md).

Current agent execution includes a tenant-scoped Scratchpad page action when enabled by the active workspace rule. The first custom-rule scope offers the four documented handling modes for Scratchpad writes; an approval-mode proposal is persisted without changing the page until a workspace member approves it. Browser, local-file, and external-account tools remain separate feature work, so these rules do not grant such access. The agent must not claim it performed external actions when no tool was used. See [the evidence ledger](research/README.md) for confirmed behavior and visual gaps.

Activity can now stop an individual one-off task. Stop is terminal, interrupts supported active agent calls, and cancels that task's pending local page approval without writing the proposed page. Stopped tasks cannot be resumed or redirected. Recurring tasks are ended in Scheduled and remain governed by their separate schedule controls. This build does not model Dots' child delegated tasks, so its Stop control applies to the Coke Dots task shown in Activity.

## Agent engines

Each task records its selected engine and its own workspace. The adapter contract returns a durable state (`done`, `waiting`, or `scheduled`), message, optional next check time and optional native session ID. The UI shows available engines and keeps the chosen engine on retries and restarts.

- **Model API:** OpenAI-compatible Chat Completions via profile settings or environment variables. The profile saves only model name and endpoint in SQLite; the API key goes to macOS Keychain. This backend has no tools.
- **Claude Code:** Set `DOTS_CLAUDE_BIN` to a local `claude` binary or `cli.js`; on this workspace layout, the sibling `coke-codex-app/vendor/claude-code/cli.js` is detected automatically. Runs in plan mode with only read/search tools and no MCP tools. Local authentication must already work.
- **Pi:** Install the optional `@mariozechner/pi-coding-agent` package, configure Pi's model credentials, and set `DOTS_PI_ENABLED=1`. The adapter supplies Pi's read-only tools. Its internal session is currently rebuilt for each turn; the task instruction and last result persist in Coke Dots.
- **DeepSeek Harness:** Install the optional SDK/runtime and set `DOTS_DSH_BIN` plus `DOTS_DSH_READ_ONLY_CONFIG` to a separately verified, read-only profile. The SDK preserves a native session ID. This adapter is opt-in because the chosen runtime profile determines its tools and credentials.

All engines must return the same structured task decision. A missing engine, invalid output or failed call is surfaced as a failed task; Coke Dots does not fabricate success. External write and send permissions are not yet connected to these engines.

## Accounts and tenant isolation

Google's immutable OpenID Connect `sub` identifies a user; verified email addresses are used to address workspace invitations. The first Google account claims the pre-authentication local workspace, preserving any existing local data. Later accounts get separate personal workspaces. Users can create additional workspaces and switch among memberships. An owner or admin can invite a verified Google email; the matching account must sign in and explicitly accept within seven days before it becomes a member. Pending invitations can be revoked, and removing a member revokes that member's sessions in the workspace. Coke Dots does not send invitation email; the inviter must notify recipients separately.

Every task, activity entry, scheduled check, profile, model setting, workspace directory, and computer browser profile is scoped by tenant ID. API requests require an opaque server-side session in an HttpOnly cookie and the session's selected workspace membership is checked on every request. Google ID tokens are signature/audience/expiry verified; OAuth state, PKCE, and nonce are validated. The server still binds to loopback, so multi-user access currently means separate Google users and workspaces on this Mac. Remote Cloudflare access is a later phase and must add HTTPS, secure cookies, and external request policy before exposing the service.

Each workspace can keep up to 20 explicitly entered notes (up to 1,000 characters each). Members can read them; creators and workspace administrators can edit or delete them. The worker includes that workspace's notes in agent requests as background facts. Coke Dots does not extract or infer notes from chat history.

The local server owns optional CLI/runtime credentials for Claude Code, Pi, and DeepSeek Harness; those host-level engine identities are shared by workspaces in this first cut. Workspace data, model API keys, and browser sessions are isolated. Per-member engine credentials remain follow-up work before exposing shared workspaces over a network.

The project is independent and is not affiliated with OpenAI.
