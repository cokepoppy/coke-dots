# Personal agent: one-time self-wake

**Reviewed:** 2026-10-14  
**Evidence class:** OpenAI product documentation, then Coke Dots implementation notes. This documents the visible behavior and our product mapping; it does not claim to reproduce OpenAI's private scheduler.

## Product evidence

- OpenAI describes Dots as continuing work between conversations and deciding when to pause and wake to continue; a fixed schedule is not required for every follow-up: [Meet dots](https://learn.chatgpt.com/docs/dots).
- The task guide says background work and proactive updates appear in the conversation, while scheduled work can be reviewed and managed in the Scheduled section: [Tasks and memory](https://learn.chatgpt.com/docs/dots/tasks-and-memory).
- OpenAI distinguishes pausing a Dot, stopping a delegated task, and cancelling a schedule as separate controls: [Control your dot](https://learn.chatgpt.com/docs/dots/controls).

## Coke Dots behavior

When the selected Agent returns `status: "scheduled"` without a recurring schedule, Coke Dots treats it as a one-time follow-up. The task keeps its ID and conversation. The Agent's checkpoint is saved as the task result and passed back as `Prior result` when the worker wakes. A due task is claimed with a conditional SQLite update so overlapping worker ticks do not dispatch the same task twice.

The chat shows the checkpoint and scheduled status. Scheduled lists this item as **Scheduled** and identifies it as a **One-time follow-up**; recurring work keeps its recurrence label. The user can open the task conversation or cancel the pending follow-up. Cancelling clears its next run and leaves the task paused so the user can resume it from Activity.

## Boundaries

- The current wake condition is a model-selected time, bounded to 1–1,440 minutes by the worker. It does not yet wake from connector webhooks or arbitrary external changes.
- SQLite task state and the existing worker loop provide restart recovery for the stored next-run time. This is not a claim that OpenAI uses SQLite, polling, or the same task state machine.
- A stored checkpoint helps the next run continue the goal; it does not prove the underlying external condition changed. The task still needs an authorized source and a verifiable result.

## Verification

- `npm test`: 71/71 unit tests passed, including a two-worker claim race, checkpoint persistence, restart, and same-task continuation.
- `npm run test:e2e`: 39 Chrome UI steps passed, including creating the one-time follow-up, finding it in Scheduled, and cancelling it. The cloud-computer tenant-isolation E2E passed in the same full run.
