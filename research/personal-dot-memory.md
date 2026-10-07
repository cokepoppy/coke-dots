# Personal Dot memory

## Source evidence

The [official Dots tasks and memory documentation](https://learn.chatgpt.com/docs/dots/tasks-and-memory) says a Dot can use relevant ChatGPT memory and maintain its own notes. The notes capture preferences, decisions, and ongoing responsibilities, are separate from ChatGPT's saved memory, and are not intended to be a full transcript. The documentation also describes proactive research creating private notes.

The reviewed hands-on videos do not show a personal-note editor, a consent prompt, or the exact point when a note is saved. The UI and confirmation used by Coke Dots are therefore implementation choices. This feature does not claim pixel parity for an unobserved reference screen.

## Coke Dots behavior

- Personal notes belong to the authenticated account, not the selected shared workspace. A task receives them only when it is a top-level task in that account's single-owner personal workspace.
- The agent may propose at most three remember, update, or forget actions from the user's direct message. Updates and deletions must reference IDs already included in that user's private context. The server applies them transactionally after a successful task result.
- Attachments, quoted content, web pages, and tool output are untrusted context and cannot be used as a source for notes. The prompt also excludes credentials and sensitive categories. These are conservative Coke Dots safeguards, not claims about Dots' internal policy.
- Users can inspect, edit, and delete notes in Profile. A saved-note Activity entry makes the automatic update visible. Workspace-shared notes remain a separate feature.
- Notes persist in the local SQLite database and survive server restart. They are not included in model calls made from shared workspaces or another account.

## Verification

`npm test` checks owner scoping, personal-workspace eligibility, persistence after reopen, bounded updates, and rejection of unknown note IDs. `npm run test:e2e` drives Chrome through saving a note from a personal task, seeing it in Profile, using it in a later personal task, and confirming its absence from shared-workspace prompts and a second account. These tests verify Coke Dots behavior only.
