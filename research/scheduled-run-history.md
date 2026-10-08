# Scheduled run history and attention state

Research date: 2026-10-09.

## Evidence boundary

- The Dots [Tasks and memory documentation](https://learn.chatgpt.com/docs/dots/tasks-and-memory) says users can review recurring work in Scheduled and choose what changes deserve an update.
- Dots [Controls documentation](https://learn.chatgpt.com/docs/dots/controls) says Scheduled is where users inspect a Dot's scheduled tasks, instructions, timing, and destination.
- General ChatGPT [Scheduled documentation](https://learn.chatgpt.com/docs/automations) says Scheduled acts as an inbox for recent runs with findings and displays an unread indicator when a run needs attention.
- The reviewed Dots YouTube frames show a selected Scheduled item and a selected-row preview, but do not show per-run history or unread markers. Their exact Dots layout remains unverified.

The run-history behavior follows official ChatGPT Scheduled documentation, while the per-run list and unread marker are Coke Dots implementation choices for the Dots Scheduled view. They are not claimed as pixels observed in Dots footage.

## Coke Dots behavior

- Each dispatched scheduled execution is stored separately from the task's latest result. The due timestamp is persisted as the active execution identity when work is claimed; this survives service recovery, and a repeated dispatch updates the same history row instead of duplicating the run.
- Run records are tenant-scoped and survive service restart. Each record contains outcome, result or error, start and finish timestamps, attention state, and read timestamp.
- A run needs attention when it asks the user, fails, or returns a result the model marked for notification. A quiet routine completion remains in history without an unread marker.
- Scheduled shows an unread dot on the task row and up to 20 recent runs in its detail pane. Automatically selecting a row loads history without clearing attention; clicking the row first loads the records, then marks unread runs as read. If loading fails, unread attention stays intact. Switching tasks clears the previous task's rows while the new history loads.
- Opening run history and clearing unread state both enforce the authenticated workspace on the server. The API does not accept a tenant id from the client.

## Verification

- `tests/core.test.ts` verifies run persistence across a database reopen, idempotent execution identity, read-state persistence, and cross-tenant isolation.
- The `Recurring work runs again automatically and remains cancellable in Chrome` path in `tests/e2e/ui.e2e.ts` waits for two real scheduled executions from the deterministic test model, checks both are unread, clicks the Scheduled row, checks both outcomes in the run list, and confirms read timestamps persist.
- The CSS follows the existing light/dark Scheduled palette. The marker position and run-list styling are not pixel-verified against Dots footage.
