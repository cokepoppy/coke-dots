# Account-scoped custom rules

## Product evidence

The [official Dots Controls documentation](https://learn.chatgpt.com/docs/dots/controls) puts custom rules in the account's Dot personalization settings. It lists four handling choices: take action without asking, take action when requested, ask before taking action, and hand off to the user. The documentation also says custom rules do not grant access to connected apps or change their permissions. The reviewed introduction videos do not show the custom-rules editor, so its pixel layout and cross-workspace switching behavior are not video-measured.

## Coke Dots behavior

- A rule belongs to one verified Google account and applies to that account's tasks across Coke Dots workspaces. Official Dots documents an exception when a workspace admin disables custom rules; Coke Dots does not yet expose that workspace control.
- Scratchpad pages, tasks, conversations, and approvals remain scoped to their workspace.
- A pending page proposal can be inspected by workspace members, but only the account that started that task can approve or decline it. The server checks this on every decision request.
- Dot reset removes the selected personal workspace's data. Account-level custom rules remain in place, like profile-level preferences.
- The first supported action category is Scratchpad page creation and update. The rule does not provide external-app or computer access.
- Existing workspace rules are migrated once per Google account. If that account had different old rules in multiple workspaces, the most recently updated rule is kept. Another account's rule remains separate.

## Verification

`npm test` covers account rule isolation, task-owner approval, migration from multiple old workspace rules, and reset behavior. The Chrome E2E saves distinct rules for two accounts, switches each account between personal and shared workspaces, and verifies that a workspace member cannot decide the other account's pending proposal. These tests validate Coke Dots implementation and do not establish exact visual parity with the reference product.
