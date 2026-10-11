# Gmail event-triggered tasks

Updated: 2026-10-11. This note separates documented adjacent-product behavior, Gmail API requirements, and Coke Dots implementation decisions. It does not claim that every behavior or screen below is present in OpenAI Dots.

## Evidence

- OpenAI's [ChatGPT Work/Scheduled documentation](https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt) describes event-triggered work from Gmail activity, including new-message conditions such as sender and subject. It also describes review and management through Scheduled. This is useful evidence for the personal-agent workflow, but it is adjacent ChatGPT Work documentation, not proof of a Dots feature or its exact UI.
- The reviewed Dots videos and retained frame notes in [the evidence ledger](README.md) do not show Gmail trigger setup. Coke Dots therefore labels this as a beta adaptation; the form's layout and interaction are not claimed as pixel-verified Dots UI.
- Google's [Gmail history list API](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list) is the incremental synchronization interface. `startHistoryId` can become invalid; a stale cursor returns HTTP 404, after which a client must synchronize mailbox state and store a current history cursor.
- Google's [Gmail search guide](https://developers.google.com/workspace/gmail/api/guides/filtering) documents `in:inbox` and `after:<UnixSeconds>` search filters. The [`messages.list` reference](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list) documents pagination and a maximum of 500 results per request.

## Recovery behavior

1. Coke Dots polls only connected Gmail accounts that have an active event trigger. Gmail authorization remains read-only (`gmail.readonly`).
2. Normal polling starts at the stored history cursor and reads only added Inbox messages. A 404 from `history.list` is treated as an expired cursor; a 404 while fetching one message's metadata is treated as a message deleted between history listing and metadata fetch, and is skipped.
3. On cursor expiry, the service fetches the current profile history ID as a baseline, searches Inbox messages from one second before the earliest active trigger, and fetches message metadata. SQLite applies an exact `receivedAt >= trigger.createdAt` check for each trigger, so old mail cannot be backfilled.
4. After the inbox scan, the service reads history from the baseline to catch mail arriving during the scan. It advances the stored cursor only after that catch-up succeeds. The per-trigger/message receipt key prevents duplicate tasks if the same message appears in both the scan and catch-up history.
5. Reconciliation is bounded to 20 pages of 100 message IDs (2,000 messages). If more pages remain, monitoring is paused with an explicit recovery-limit error rather than silently advancing the cursor. The current bounded limit is an operational guard; sustained high-volume mailboxes need a resumable reconciliation cursor before production rollout.

Triggers, event receipts, tasks, and Gmail refresh tokens remain scoped to the initiating user and tenant. Message snippets are marked untrusted context and only create read-only tasks; the feature does not send or modify Gmail content.

## Verification scope

- `tests/gmail.test.ts` has a local HTTP fixture that makes the stored cursor return 404, supplies an older matching email, supplies a new message during reconciliation, and supplies another message in catch-up history. It checks that old mail is skipped, both new messages create one task each, the recovered cursor is used on the next poll, and all Gmail requests are read-only.
- `tests/e2e/ui.e2e.ts` exercises the Gmail connection and trigger setup through Chrome against mock Google OAuth, Gmail, and model endpoints. It proves the UI and tenant isolation path, not live Google OAuth or live mailbox delivery.
- No real Google account is used by the automated tests. A production Gmail connection still needs a consent-screen and Gmail API quota check.

Verification on 2026-10-11: `npm test` passed 133 tests; `npm run build` passed; `node --import tsx tests/e2e/ui.e2e.ts` passed all 55 Chrome browser steps. The Gmail UI/result and second-account isolation screenshots are in the ignored local artifact run `artifacts/e2e/2026-10-11T02-55-23-014Z/` (`14-gmail-oauth-consent.png`, `15-gmail-event-task-result.png`, and `16-beta-gmail-isolation.png`). This E2E run uses mock providers and is not live Google verification.

## Current implementation boundary

The event task's analysis runs through the selected per-task Agent kernel in the tenant's Debian cloud computer. Gmail provider credentials are separate from Dots user login and from the shared instance model profile. The trigger/task records and Agent runtime state remain tenant/user isolated.
