# GitHub pull-request event tasks

Updated 2026-10-09. This feature is based on current official task documentation and GitHub webhook security guidance. The reviewed Dots videos do not show GitHub event-task setup, so the configuration UI is a documented product behavior adaptation and is not claimed to be pixel-verified.

## Product evidence

- [OpenAI: Scheduled tasks in ChatGPT](https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt), reviewed 2026-10-09. The article says event-triggered tasks run in Work and respond to supported Gmail, Slack, or GitHub activity. GitHub tasks can respond to supported Pull Request activity in an authorized `github.com` repository. It describes reviewing Trigger, Condition, and Prompt, then managing tasks in Scheduled; actions needing approval can pause a task. It also documents event-triggered task limits of 30 runs per hour and 720 per day.
- [OpenAI: Getting started with your dot](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot), reviewed 2026-10-09. The Dot can keep working between conversations, users can change direction, and task activity and the computer are available from the profile.

## Webhook security evidence

- [GitHub: Validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries) requires validating the raw payload with the configured high-entropy secret and `X-Hub-Signature-256`, using HMAC-SHA256 and a constant-time comparison.
- [GitHub: Best practices for webhooks](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-webhooks) recommends subscribing only to needed events, using HTTPS and a secret, checking event type and action, responding within 10 seconds, and using `X-GitHub-Delivery` to deduplicate deliveries.

## Coke Dots implementation contract

- A trigger is stored under one tenant, created by a tenant owner/admin, and references only `owner/repo`, selected Pull Request actions, a user-defined condition, instructions, and a cloud kernel (`pi` or `dsh`). In production, these engines must be available through the tenant Debian cloud computer.
- The owner manually adds a GitHub repository webhook using the generated URL and one-time secret. The secret is stored only in the Mac Keychain under a tenant-and-trigger-specific account. Snapshot/list APIs never include it. Removing the trigger removes its Keychain entry; workspace reset removes all tenant trigger secrets and delivery receipts.
- Only signed `pull_request` events for the configured repository and selected supported actions can create work. The raw body is verified before parsing. A tenant-scoped `(trigger_id, delivery_id)` receipt and a queued task are written atomically; repeated deliveries cannot duplicate the task. Paused or non-selected events are durably ignored. The tenant event limit is 30 queued runs/hour and 720/day.
- Triggered tasks run read-only on the selected Pi/DeepSeek Harness kernel, have lower queue priority than user-assigned tasks, and record the repository, PR number, title, body excerpt, author, and action in Activity. Pull-request metadata is treated as untrusted evidence. The integration does not fetch code/diffs, authenticate private-repository API requests, publish comments, merge, or change repository files.
- This manual webhook setup differs from OpenAI's documented connected-app authorization flow. A GitHub OAuth/App connection that reads PR code and exposes repository authorization is a separate feature. Until then, the UI and Activity must say “metadata only” and must not describe the run as a code review.
- The Scheduled configuration/detail states are derived from the official Trigger/Condition/Prompt and task-management contract. No reviewed video demonstrates these GitHub controls, so visual parity for this screen is not claimed.

## Verification required

- Unit tests: GitHub's published signature vector, malformed or tampered signatures, per-tenant trigger listing, task/receipt atomicity, replay deduplication, action selection, pause behavior, rate limits, cleanup, and no secret in `Snapshot`.
- Chrome E2E: create a trigger through Scheduled, copy the one-time secret/URL, deliver a signed fixture through the public webhook route, inspect the queued Activity task, retry the same delivery, reject a bad signature, verify Beta tenant isolation, pause/resume, delete, and confirm that the secret is no longer in Keychain.
