# Persistent Pi sessions per task

## Dots evidence

The official [Tasks and memory guide](https://learn.chatgpt.com/docs/dots/tasks-and-memory) says a dot keeps working between conversations, follows through as things change, can pause and wake to continue, and can split work into parallel background agents. It also says Activity lets a user inspect progress, results, and requests for input. This establishes the continuity requirement for the product; it does not claim that OpenAI Dots uses Pi or any specific agent engine.

## Coke Dots implementation

Pi's native session file is stored under the current task workspace at `.coke-dots/pi-sessions`. A subsequent turn opens the session ID persisted on the task. If the worker exits before that ID reaches SQLite, it recovers a session only when there is exactly one candidate in that task workspace. An unknown ID, multiple ID-less candidates, or a session path outside the task state directory fails closed.

The task workspace already has the tenant and task IDs in its path (`data/workspaces/{tenantId}/{taskId}`), so the session directory remains task-specific. The `.coke-dots` and `pi-sessions` directories are forced to mode `0700`; resolved symlinks are checked before Pi reads or writes session history. The adapter returns Pi's session ID through the shared `AgentDecision`, allowing the existing worker/store flow to persist it without adding a separate session table.

## Verification

`npm test` exercises Pi's real `SessionManager` without making model requests: it verifies that a saved conversation is reopened, an interrupted first turn can recover a single session, another tenant workspace cannot open that session, multiple candidates fail closed, and symlinks cannot redirect the directory or change permissions outside the task workspace. These checks verify the adapter's session storage boundary, not Pi's ability to complete a model task after a server restart.
