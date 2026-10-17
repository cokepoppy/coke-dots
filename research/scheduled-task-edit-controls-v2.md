# Scheduled task editing

## Evidence

- OpenAI's [Getting started with your dot](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot) says users can open a task to change its repeat schedule, time, and completion notifications, and can pause a dot.
- OpenAI's [Dots tasks and memory documentation](https://learn.chatgpt.com/docs/dots/tasks-and-memory) says recurring schedules can include a time zone and end date, and users can review, change, or cancel saved schedules in Scheduled. It also distinguishes stopping active work from canceling a schedule.
- OpenAI's [Scheduled tasks help page](https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt) confirms Scheduled supports reviewing, editing, pausing, resuming, and deleting tasks.
- The public videos reviewed so far do not show this editor's exact controls or pixels. The editor reuses Coke Dots' existing recurrence fields; pixel-level parity for this state remains unverified.

## Behavior

- Scheduled task details can edit interval, daily, or weekly recurrence, local time, time zone, selected weekdays, and optional end date.
- An edited active task gets a newly computed next run. Editing a paused task preserves its paused state and no next run.
- A failed task with a valid recurring schedule can be edited or resumed. A queued first run may be edited or paused only while its next run is still in the future.
- Pause, resume, edit, and cancel operations are tenant-scoped. A request from another tenant returns 404.
- The model API remains shared at the instance level; schedule data remains attached to the tenant's task.

## Test harness

- E2E OAuth and model credentials use a disposable JSON keychain adapter only when both `NODE_ENV=test` and `DOTS_TEST_KEYCHAIN=1` are set. The temporary file is created with mode 0600. Production continues to use the native macOS Keychain.
- This keeps local Chrome E2E independent from whether the user's macOS login keychain is unlocked.

## Verification

- `npm test`: 70 passed.
- `npm run test:e2e`: 38 Chrome browser steps passed, including schedule edit, pause, edit while paused, resume, cancellation, and cross-tenant denial. The Linux cloud-computer checks also passed.
- Chrome captured the edited daily task state at [edited-daily-schedule.png](evidence/scheduled-task-edit-controls/edited-daily-schedule.png) (1440 × 1000). It is replica output for review, not an OpenAI reference frame.
- These are local fixture-backed E2E results, not a signed-in test against the public VPS domain.
