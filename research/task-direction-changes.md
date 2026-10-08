# Changing direction during active work

## Product evidence

The current [Tasks and memory documentation](https://learn.chatgpt.com/docs/dots/tasks-and-memory) says a Dot can handle multiple responsibilities and that a user can switch tasks, add details, or change priorities. The [Controls documentation](https://learn.chatgpt.com/docs/dots/controls) places ongoing-work review and new instructions in Activity and explicitly says users can change direction while work continues.

The documents establish that active work can be steered. They do not specify whether an in-flight model or tool request is interrupted, whether partial results are retained, or how that transition is represented in the task history. The reviewed V1 video at 02:46 and 06:06 shows a task request and a later instruction, but not enough detail to claim exact interruption behavior.

## Coke Dots implementation

- Activity opens the existing task conversation. “调整这项工作的要求” submits the revised instruction against the same task ID.
- The server persists the new instruction and user-history entry, changes the task back to `queued`, and aborts the task's current `AbortController` signal.
- The old run cannot commit its response once the task is no longer `working`. When the run unwinds, the worker sees the updated task and starts one new call with the revised instruction.
- For Pi and DeepSeek Harness tasks running inside the tenant's Debian computer, the control plane sends an authenticated remote stop request and waits for the remote run to settle before releasing the task slot. The Agent runtime lets the adapter handle `SIGTERM` and allows up to 12 seconds for SDK cleanup before forcing process termination. This prevents a replacement instruction from colliding with the old DSH session or browser-control process.
- This interruption-and-rerun rule is a Coke Dots implementation choice. It does not claim that OpenAI Dots uses the same internal mechanism.

Aborting a request cannot undo a side effect that was already completed before the user changed direction. Tool adapters receive the abort signal, and the worker does not commit a late response; external actions still require their existing authorization and review path.

## Verification

- Unit test `redirecting a working task aborts its old model call before the new instruction runs` holds the first HTTP model response open, redirects the task, confirms that the connection is aborted, and verifies one request for the new instruction, one final result, the retained user entry, and no stale result.
- `tests/linux-desktop.test.ts` verifies an abort sends the task ID to the remote stop endpoint and keeps the old Agent request open until the endpoint confirms shutdown. `tests/agent-runtime.test.ts` holds a kernel process during graceful cleanup, confirms stop does not acknowledge early, then reuses the same task ID with a replacement instruction. `tests/cloud-kernel-adapter.test.ts` checks both Pi session disposal and DeepSeek Harness close on abort.
- Chrome E2E step `Redirecting an active task aborts the old model call and continues with the new direction in Chrome` creates a task, opens Activity details, changes its instruction while the mock model call is held, and verifies the same task finishes with the new result. The latest screenshot is `artifacts/e2e/2026-10-08T17-27-34-327Z/screenshots/20b-active-task-redirected.png`.
- On 2026-10-09, `npm test` passed all 123 unit tests, `npm run build` passed, and `npm run test:e2e` passed 53 Chrome steps and all 8 cloud-computer checks. These local tests use deterministic providers and verify Coke Dots behavior, not OpenAI's backend implementation.
