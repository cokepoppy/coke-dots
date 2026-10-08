# Personal agent self-wake and continuity

## Evidence and limits

The current [official Getting started with your dot article](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot) describes an always-on agent that keeps making progress between conversations, reviews connected information proactively, and can run reminders or recurring tasks. It says Scheduled lists active, paused, and completed work, and users can pause their Dot. The older [tasks and memory documentation](https://learn.chatgpt.com/docs/dots/tasks-and-memory) and [controls documentation](https://learn.chatgpt.com/docs/dots/controls) describe continuity and reviewing progress in Activity. These sources establish ongoing responsibility, not the internal scheduler or the UI for an agent-chosen one-time wake.

The reviewed hands-on videos show Dot receiving work and later instructions, but do not clearly show the same task saving an intermediate checkpoint, entering a one-time sleeping state, and waking itself. The Scheduled frames in V1 show a monitoring list and a failed chat-open state; they do not establish how one-time follow-ups are represented. Therefore Coke Dots' `One-time follow-up` label and placement in Scheduled are implementation choices, not pixel-verified Dots UI.

## Coke Dots behavior

- A model may return `scheduled` with a bounded `nextMinutes` delay. This creates one future execution of the same task; it does not turn the task into a recurring schedule.
- When the Dot schedules that continuation, Coke Dots stores its message as the task's latest result and appends the same message to task history. A later stateless Model API request receives that checkpoint as `Prior result`.
- A scheduled one-time responsibility appears in Scheduled beside recurring tasks, with `One-time follow-up`, its latest checkpoint, and its next wake time. The existing Activity view also shows task state and result.
- On wake, the worker updates the original task. It does not create a duplicate. The next model decision may finish, wait for the user, or schedule another bounded continuation.
- These are local scheduler semantics. They do not prove that OpenAI Dots uses `nextMinutes`, stores a result in this way, or presents a one-time follow-up with this wording.

## Verification

`tests/core.test.ts` verifies checkpoint persistence, no recurrence metadata, due-task wake, same-task identity, checkpoint delivery to the second Model API call, and both messages in history.

The Chrome flow in `tests/e2e/ui.e2e.ts` assigns the responsibility, sees its checkpoint in Scheduled, restarts the local service, reloads Chrome, advances the persisted due time in the test database, waits for the worker to wake, then confirms the same task completed and appears in Activity. The model is a local deterministic fixture. This verifies Coke Dots' browser, storage, and worker path; it does not verify the live DeepSeek provider or OpenAI Dots internals.
