# Global Dot pause: evidence and implementation

Research date: 2026-10-08.

## Product evidence

OpenAI's [Controls documentation](https://learn.chatgpt.com/docs/dots/controls) says Pause stops the Dot's current main task, does not stop every delegated task, and does not cancel future scheduled runs. Activity is where a delegated task can be inspected or stopped; Scheduled is where a recurring task can be disabled or deleted. Resume continues a paused Dot.

The [Tasks and memory documentation](https://learn.chatgpt.com/docs/dots/tasks-and-memory) confirms that a Dot can work across conversations, run parallel background agents, and perform recurring work at saved times. The reviewed hands-on videos do not show the Pause control. The exact visual dimensions and treatment of page watches remain unverified.

## Coke Dots behavior

- Pause remains tenant-scoped and durable. Only a shared workspace owner or admin can change it; the API enforces the same rule as the control.
- Pausing interrupts active top-level tasks and records them for resume. It does not abort delegated children. A parent waits in the queue after its children finish, then aggregates their results after resume.
- Ordinary queued top-level tasks wait while the Dot is paused. A due scheduled occurrence can still run, and its saved schedule advances to the next occurrence.
- Resume requeues only tasks interrupted by that pause. It does not restart already-completed delegated work.
- Page watches remain a separate Coke Dots polling extension. Their pause interaction is not demonstrated in official Dots material and remains an implementation choice.

The first four rules follow the documented distinction between main work, delegated work, and future scheduled runs. The exact handling of multiple active top-level tasks is an implementation interpretation: Coke Dots pauses each active top-level task in the tenant.

## Verification

`npm test` passed all 95 tests, including tenant-scoped pause persistence, delegated-child continuation, due scheduled work, and resuming the parent once. `npm run test:e2e` passed 49 Chrome steps; its pause click-through observes a child finish while the parent waits and verifies one parent aggregation after resume. The same run passed the cloud-computer browser checks. `npm run test:e2e:k3d` also passed against a disposable tenant on the live `tp1121-sandbox-dev` cluster, including Debian 13, noVNC takeover, live Agent adapter execution, and workspace persistence after Pod recreation.

Artifacts: Chrome traces and manifest at `artifacts/e2e/2026-10-08T02-07-22-844Z`; cloud-computer screenshots at `artifacts/e2e/linux-cloud-computer-2026-10-08T02-09-31-619Z`; live K3D screenshots and comparisons at `artifacts/e2e/k3d-cloud-computer-2026-10-08T02-10-08-893Z` (ignored local output).

Screenshots and click paths verify Coke Dots behavior. They are not Dots reference frames, so they do not establish pixel parity for the profile menu.
