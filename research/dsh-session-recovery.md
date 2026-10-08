# DeepSeek Harness session recovery

## Observed failure

On 2026-10-08, the Chrome live-model E2E sent a small real task through the installed DeepSeek Harness runtime and the configured DeepSeek API. The task created one child, the child completed, and the parent restarted its DSH run to synthesize the child result. That continuation failed with the runtime error `session "session-…" already exists`; the parent Activity card remained failed even though the child result was available.

The failure was repeatable in the end-to-end flow and was not an API-key or provider error. The one-off task's new DSH process opened a session store that had restored the saved ID, but the DSH SDK JSON-RPC server did not have a live agent handle for that restored session. A fresh `session/prompt` therefore tried to create the same ID again. The SDK's duplicate-session error occurs before it accepts the new prompt.

## Recovery behavior

Coke Dots now recognizes only the SDK's exact `session "<id>" already exists` error. It retries once with a newly minted SDK session ID, using the same bounded task prompt. That prompt still includes the task instruction, the prior result, and any completed child results. Provider errors, malformed results, cancellation, and other session errors are not retried.

This keeps the Agent's background responsibility moving after the DSH subprocess is recreated. It cannot recover the full hidden DSH transcript from the old process; the continuation is grounded by Coke Dots' persisted task state and supplied child results. The retry does not claim to mirror an internal OpenAI Dots mechanism.

## Verification

- `node --import tsx --test tests/adapters.test.ts` passes the tenant-isolation and DSH adapter tests. A fake SDK runtime persists a session ID across two separate child processes, returns the actual duplicate-session error on resume, then verifies one retry with a new ID while preserving the tenant-only API key and model route.
- `npm run test:e2e:live-dsh-delegation` passed on 2026-10-08 using Chrome, the local test OAuth provider, the saved Keychain model credential, the installed DSH CLI, and a real DeepSeek API call. It creates one child using DSH, waits for its completion, checks the parent recovery event and new session, and verifies the final marker in the parent Activity card. The latest completed screenshot is `artifacts/e2e/live-dsh-2026-10-08T01-33-41-662Z/live-dsh-task-completed.png` (local ignored test artifact).
- `npm run test:e2e:live-model` separately passed a real direct DSH task and a Model API task. The live test fixture uses temporary SQLite data and does not write tasks to the user's persistent workspace.

## Evidence boundary

This verifies Coke Dots' local DSH adapter, browser flow, and task recovery against the installed DSH SDK/runtime. It does not reveal how OpenAI Dots persists native Agent sessions, and it does not establish visual parity for any unobserved Dots page.
