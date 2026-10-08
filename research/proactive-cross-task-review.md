# Proactive cross-task review

## Reference evidence

OpenAI's [Tasks and memory documentation](https://learn.chatgpt.com/docs/dots/tasks-and-memory) says a Dot can review connected information proactively, relate new information to earlier work, and surface suggestions or questions. The docs describe this as research: it does not send messages, modify apps, or control a computer. The [Controls documentation](https://learn.chatgpt.com/docs/dots/controls) describes reviewing progress and permissions in Activity. The public videos reviewed so far do not show this exact release-date-conflict sequence, so the dates below are an illustrative scenario grounded in the documented behavior, not a frame-by-frame recreation of a recorded Dots workflow.

## Demonstration

1. The user gives Dot an announcement draft using October 21 and asks it to leave the draft waiting for approval. The task remains open; nothing is sent or published.
2. Later, the user shares a new release decision that moves launch to October 22 and asks for a summary.
3. After that work completes, Dot compares it with the tenant's active responsibilities in a separate proactive research task.
4. Dot notices the conflicting dates, reports the conflict in Activity, and asks whether the user wants the draft updated. It does not change the draft, send a message, access a connected app, or add memory.

## Coke Dots implementation and boundaries

- The host worker schedules and tracks the review. In Linux desktop mode, it sends the task to the tenant's Debian computer endpoint; the Pi or DeepSeek Harness kernel process runs there. There is no fallback to a host-side kernel when the cloud runtime is unavailable.
- The review receives a bounded JSON snapshot of the completed task, up to six still-active tenant tasks, and permitted tenant notes. It does not receive browser, computer, file, message, schedule, delegation, Scratchpad-write, or private-memory-write capabilities.
- A supported model result needs an explicit `proactiveFinding` boolean. A useful finding appears in Activity and can use the workspace notification preference. No finding is stored with a null result and is hidden from the visible Activity list.
- The Chrome E2E uses a deterministic local model fixture. It verifies the click path, persisted waiting/completed states, tenant task context, the conflict result, and the absence of page or personal-memory writes. It does not call the live DeepSeek service or claim to expose OpenAI's internal scheduler.

Run `npm run test:e2e:proactive-demo` to replay the browser flow and regenerate the local WebP and screenshots under `artifacts/demos/proactive-release-date-conflict/`.
