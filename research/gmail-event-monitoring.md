# Gmail event monitoring evidence

Reviewed 2026-10-11. This record separates OpenAI's documented workflow, Google's mailbox-change API, the Coke Dots implementation, and what remains unverified from hands-on Dots footage.

## Product evidence

- [ChatGPT Work and Codex](https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex) documents event-triggered Work tasks as webhook-based. It lists new Gmail messages as a supported event, permits sender and subject filters, asks the user to review Trigger, Condition, and Prompt, and places task management in Scheduled.
- [Dots tasks and memory](https://learn.chatgpt.com/docs/dots/tasks-and-memory) separates recurring schedules from supported event monitoring. It says users should specify which event to watch and when the Dot should notify them; a connection by itself does not create a monitoring task.
- [Connect computers and apps](https://learn.chatgpt.com/docs/dots/computers-and-apps) documents connecting Gmail and reviewing the connected account's permitted actions, including read access without send access.
- Neither the reviewed V1 Futurepedia video nor the V2 John Aspinall video demonstrates Gmail event setup. The current form, copy, dimensions, and placement have no visual source frame and are not claimed to be pixel-matched.

## Google API evidence

- Gmail [`users.history.list`](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list) returns mailbox history after a `startHistoryId`, supports `messageAdded`, pagination, and optional label filtering. Google says an old cursor can return HTTP 404 and a history ID is typically valid at least a week, though it can expire sooner.
- Google's [sync guide](https://developers.google.com/workspace/gmail/api/guides/sync) recommends history-based partial sync after a baseline and a full sync if history is unavailable. It also documents push notifications as a way to avoid polling.

## Coke Dots behavior on `feature/gmail-event-triggered-isolated`

- OAuth asks for `gmail.readonly`; refresh tokens stay in the system Keychain. Gmail connections, triggers, task receipts, snippets, Activity, and results are scoped to both the Coke Dots tenant and the Google user.
- The server polls Gmail history every 60 seconds, limited to messages with the `INBOX` label. The UI now states both the polling interval and Inbox scope. A matching sender/subject creates a durable, idempotent Pi or DeepSeek Harness task. Email snippets are untrusted evidence; these event tasks cannot delegate, create schedules, or write to Scratchpad.
- When the Gmail cursor expires, the service performs a bounded Inbox reconciliation from trigger creation time, then catches up from a fresh history cursor. More than the supported recovery bound pauses monitoring rather than advancing the cursor and silently losing work.
- This is a polling implementation of the user-visible event workflow. It does not match OpenAI Work's documented webhook transport or guarantee webhook-like latency. The current UI starts trigger setup in Scheduled instead of the documented Work conversation flow; that interaction remains a known fidelity gap pending a direct reference capture.

## Verification and limits

- On 2026-10-11, `npm test` passed 61/61 unit tests.
- `npm run test:e2e` built the app, passed 36 Chrome click-through steps, and passed all 8 cloud-computer checks. The Gmail Chrome path exercised OAuth consent, read-only scope, expired history cursor recovery, trigger creation, Pi dispatch inside the tenant cloud computer, duplicate suppression, Activity output, pause/resume, and mailbox isolation between users and tenants.
- Artifacts are local and ignored: `artifacts/e2e/2026-10-11T11-45-50-679Z/` and `artifacts/e2e/linux-cloud-computer-2026-10-11T11-43-30-159Z/`.
- The E2E uses local Google, Gmail, and cloud-Agent fixtures. It verifies our control flow and isolation; it does not validate live Google OAuth verification, read a real mailbox, prove actual Google push delivery, or establish visual parity with Dots.
