# Account-scoped custom rules

## Product evidence

The [official Dots Controls documentation](https://learn.chatgpt.com/docs/dots/controls) puts custom rules in the account's Dot personalization settings. It lists four handling choices: take action without asking, take action when requested, ask before taking action, and hand off to the user. The documentation also says custom rules do not grant access to connected apps or change their permissions. The [Dots workspace administration guide](https://help.openai.com/en/articles/20001554-manage-dots-in-chatgpt-workspaces) documents a separate “Use custom rules for dots” permission: when unavailable, members cannot add or edit custom rules and saved rules do not apply, while built-in action rules remain active. The reviewed introduction videos do not show either settings surface, so their pixel layout is not video-measured.

## Coke Dots behavior

- A rule belongs to one verified Google account and applies to that account's tasks across Coke Dots workspaces. A shared-workspace owner or admin can disable rules for one workspace. This retains the account's saved rule while preventing it from applying or being edited in that workspace; the same rule remains available in the account's other workspaces.
- To preserve existing Coke Dots behavior, workspaces default to enabled. This is a local migration choice; OpenAI documents the permission as off by default for Enterprise.
- Scratchpad pages, tasks, conversations, and approvals remain scoped to their workspace.
- A pending page proposal can be inspected by workspace members, but only the account that started that task can approve or decline it. The server checks this on every decision request.
- Dot reset removes the selected personal workspace's data. Account-level custom rules remain in place, like profile-level preferences.
- The first supported action category is Scratchpad page creation and update. The rule does not provide external-app or computer access.
- Existing workspace rules are migrated once per Google account. If that account had different old rules in multiple workspaces, the most recently updated rule is kept. Another account's rule remains separate.

## Verification

`npm test` covers account rule isolation, workspace-owner/admin access, disabled-workspace prompt suppression, rule retention, and continued application in other workspaces. The Chrome E2E clicks the admin setting off and on, verifies member read-only status and server-side rejection of direct member/admin bypass writes, checks that an assigned task omits the saved account rule only in the disabled workspace, then checks that the rule still reaches tasks in the same account's personal workspace. The settings layout is functional and documented, not visually verified against Dots footage.
