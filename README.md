# Coke Dots

An evidence-led, local-first personal agent project. Features are developed on separate branches, with observed Dots behavior recorded before implementation.

## Run locally

Requires Node.js 24 or newer. Run `npm install`, then set `DOTS_MODEL`, `DOTS_MODEL_API_KEY`, and optionally `DOTS_MODEL_BASE_URL` in the server process environment. The current model adapter uses the OpenAI-compatible `/chat/completions` endpoint. Run `npm run dev` and open `http://127.0.0.1:5173`.

The background worker and web UI are separate processes. Closing the browser window leaves the worker running. `DOTS_DATA_DIR` defaults to `./data`; the SQLite database is never committed. Starting the server again recovers any task left in `working` state. `npm test` and `npm run build` verify the core. Without a configured model, tasks explicitly fail and can be retried after configuration.

For the Mac shell, run `npm run desktop`. It builds the web UI, server and Electron wrapper, starts a detached local server if needed, and opens the app. Closing the window leaves that server running. `npm run dev:desktop` runs the UI with Vite. The current shell requires Node.js 24 on the Mac and is a local development build, not a signed installer.

Current agent execution is limited to reasoning over the user's supplied text. Browser, file and account tools are separate feature work. The agent must not claim it performed external actions when no tool was used. See [the evidence ledger](research/README.md) for confirmed behavior and visual gaps.

The project is independent and is not affiliated with OpenAI.
