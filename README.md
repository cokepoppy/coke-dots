# Coke Dots

An evidence-led, local-first personal agent project. Features are developed on separate branches, with observed Dots behavior recorded before implementation.

## Run locally

Requires Node.js 24 or newer. Run `npm install` and `npm run dev`, then open `http://127.0.0.1:5173`. Configure an OpenAI-compatible `/chat/completions` model from the dot profile; the API key goes to macOS Keychain. Environment variables `DOTS_MODEL`, `DOTS_MODEL_API_KEY`, and `DOTS_MODEL_BASE_URL` are also accepted and take precedence for development.

The background worker and web UI are separate processes. Closing the browser window leaves the worker running. `DOTS_DATA_DIR` defaults to `./data`; the SQLite database is never committed. Starting the server again recovers any task left in `working` state. `npm test` and `npm run build` verify the core. Without a configured model, tasks explicitly fail and can be retried after configuration.

For the Mac shell, run `npm run desktop`. It builds the web UI, server and Electron wrapper, starts a detached local server if needed, and opens the app. Closing the window leaves that server running. `npm run dev:desktop` runs the UI with Vite. The current shell requires Node.js 24 on the Mac and is a local development build, not a signed installer.

Current agent execution is limited to reasoning over the user's supplied text. Browser, file and account tools are separate feature work. The agent must not claim it performed external actions when no tool was used. See [the evidence ledger](research/README.md) for confirmed behavior and visual gaps.

## Agent engines

Each task records its selected engine and its own workspace. The adapter contract returns a durable state (`done`, `waiting`, or `scheduled`), message, optional next check time and optional native session ID. The UI shows available engines and keeps the chosen engine on retries and restarts.

- **Model API:** OpenAI-compatible Chat Completions via profile settings or environment variables. The profile saves only model name and endpoint in SQLite; the API key goes to macOS Keychain. This backend has no tools.
- **Claude Code:** Set `DOTS_CLAUDE_BIN` to a local `claude` binary or `cli.js`; on this workspace layout, the sibling `coke-codex-app/vendor/claude-code/cli.js` is detected automatically. Runs in plan mode with only read/search tools and no MCP tools. Local authentication must already work.
- **Pi:** Install the optional `@mariozechner/pi-coding-agent` package, configure Pi's model credentials, and set `DOTS_PI_ENABLED=1`. The adapter supplies Pi's read-only tools. Its internal session is currently rebuilt for each turn; the task instruction and last result persist in Coke Dots.
- **DeepSeek Harness:** Install the optional SDK/runtime and set `DOTS_DSH_BIN` plus `DOTS_DSH_READ_ONLY_CONFIG` to a separately verified, read-only profile. The SDK preserves a native session ID. This adapter is opt-in because the chosen runtime profile determines its tools and credentials.

All engines must return the same structured task decision. A missing engine, invalid output or failed call is surfaced as a failed task; Coke Dots does not fabricate success. External write and send permissions are not yet connected to these engines.

The project is independent and is not affiliated with OpenAI.
