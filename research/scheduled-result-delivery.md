# Scheduled result delivery

## Product evidence

OpenAI's Dots recurring-task documentation asks users to specify four things: what to check or update, when to run (including time zone and optional end date), which changes deserve a notification, and where results should be delivered. It also says to review recurring work in Scheduled and inspect what was saved. The official Controls page says Scheduled exposes the task instructions, timing, and destination. These are written product requirements; the available V1/V2 YouTube captures show the Scheduled list/detail surface but do not demonstrate a destination picker or Slack scheduled-result delivery.

Sources:

- O3: https://learn.chatgpt.com/docs/dots/tasks-and-memory#recurring-tasks
- O5: https://learn.chatgpt.com/docs/dots/controls#review-work
- See [the evidence ledger](README.md#source-register) for source classes and video limitations.

## Coke Dots behavior

- A new recurring task defaults to the Dots conversation and notifies only when the run needs the user's attention.
- The user can select the linked Slack contact workspace and choose to deliver every run. Coke Dots resolves the creator's own Slack identity from the active tenant. The request cannot provide a Slack user or channel ID.
- Delivery is a private Slack DM. Each scheduled execution gets one durable SQLite outbox row keyed by tenant, task, and execution key. Retries reuse the same message idempotency key and stop after five attempts.
- Run history shows pending, sent, or dead-lettered status and the last bounded error. Run output is taken from that execution's saved history, never from a newer task result.
- The task creator must still be a member of the tenant and have one linked Slack identity for the selected workspace when delivery runs. Missing membership, identity, installation, or token becomes a visible retry and then dead-letter state; delivery is not redirected to another user.
- Tenant and creator identity checks are enforced on the server and in storage. The UI reports the destination and notification condition in Scheduled.

## Verification

- `tests/slack.test.ts` covers linked identity resolution, tenant isolation, default attention-only delivery, every-run delivery, replay idempotency, run-specific results, durable retry/dead-letter status, and database reopen.
- `tests/e2e/ui.e2e.ts` uses Chrome to select Slack and every-run in the recurrence editor, executes two scheduled runs, verifies two private DMs and two durable sent outbox records, and proves a second Google tenant is rejected without creating a task.
- A mocked local Slack API is used in automated tests. No real Slack message is sent by these checks.

The selector and its exact layout have no corresponding YouTube frame. They implement the official text contract and are not claimed as pixel-verified OpenAI UI.
