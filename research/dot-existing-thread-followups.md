# Dot follow-up instructions in visible delegated threads

Research date: 2026-10-14

## Evidence

The official [Tasks and memory documentation](https://learn.chatgpt.com/docs/dots/tasks-and-memory) says Dot can divide work among parallel background agents, create separate visible threads, and send follow-up instructions. It says those threads can be opened and steered from desktop, web, and mobile, and that tasks created by Dot continue in their original computer or cloud environment. The same page says Activity exposes task progress and accepts instructions while work continues. The [Controls documentation](https://learn.chatgpt.com/docs/dots/controls) independently describes reviewing ongoing work and changing direction.

This documentation confirms the capability and user-visible thread boundary. It does not specify the exact control placement, copy, animation, or whether every follow-up appears as a chat bubble in the same way. No pixel-level claim is made for this interaction.

## Existing Coke Dots behavior before this change

Parent tasks could create up to three tenant-owned child task records. Those tasks appeared as separate items in Recent and Activity and opened into their own chat history, but the parent could only receive a one-time aggregate. Its agent protocol rejected a follow-up instruction aimed at an existing child thread.

## Implemented behavior

- A top-level parent may use an existing child result to request a bounded follow-up to that direct child, up to three appended instructions per parent task.
- The existing child task ID, workspace, computer, and Pi/DSH session are reused. No new child conversation is created.
- The instruction is stored as a Dot message in the child conversation, then the worker resumes the child. The parent remains delegating until all child threads finish, then runs its aggregate pass again.
- Follow-ups are rejected when the child is not a direct child of the same tenant and parent, is still active, or exceeds the per-parent limit. Child agents cannot recursively delegate or schedule tasks.
- Chrome E2E uses the local test model and clicks Activity -> child details to verify that the Dot instruction appears in the continuing child thread. This proves Coke Dots UI and control flow; it does not prove signed-in public VPS behavior or pixel parity with the reference product.

## Verification

Verified on branch `feature/visible-delegated-threads` on 2026-10-14:

- `npm test`: 68 passed, 0 failed.
- `npm run build`: TypeScript check and Vite production build passed.
- `npm run test:e2e`: 37 Chrome browser steps passed, including clicking Activity, opening the existing Competitor scan thread, checking the Dot follow-up message, and observing the parent aggregate after the child completes.
- The same command's Linux cloud-computer suite passed all 8 checks, including remote Agent dispatch and tenant runtime separation.
- This is local E2E against a deterministic mock model and isolated test tenants. It is not signed-in public VPS validation, and does not establish pixel parity for the follow-up UI.

The first E2E attempt exposed a mock-timing race: the immediate follow-up response completed before Chrome could inspect the delegating state. The test now holds that response until the browser opens the child thread and verifies the appended Dot message.
