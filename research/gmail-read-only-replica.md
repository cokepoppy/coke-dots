# Gmail read-only connection: evidence and implementation boundary

Research checked 2026-10-10 against OpenAI's public Dots documentation. This is product-behavior evidence, not evidence of OpenAI's internal OAuth implementation.

## Official evidence

- [Get started with your dot](https://learn.chatgpt.com/docs/dots/getting-started) says app connections are optional and separate from messaging and computer access. It lists email among the services a Dot can connect to.
- [Connect computers and apps to your dot](https://learn.chatgpt.com/docs/dots/computers-and-apps) names Gmail as a connected app for finding relevant email. It says app access follows the connected account and its permissions, and that a user can allow reading email without allowing sending email.
- [Tasks and memory](https://learn.chatgpt.com/docs/dots/tasks-and-memory) documents recurring tasks that can check sources and supported app events. It also says proactive research can read permitted sources but cannot send messages, modify connected apps, or control a browser/computer.
- [Control your dot](https://learn.chatgpt.com/docs/dots/controls) describes review and approval when an action affects an account or shares information.

The docs support a read-only Gmail connector and a future proactive email monitor. They do not establish the exact Gmail OAuth consent screen, connection card, Gmail search syntax, API calls, polling interval, or internal agent architecture. Those details remain implementation choices until captured from a real Dots session or reliable video frame.

## Coke Dots implementation in this branch

- Gmail authorization is a separate, explicit OAuth flow. The existing Coke Dots Google sign-in still requests only `openid`, `email`, and `profile`.
- The connector requests only `https://www.googleapis.com/auth/gmail.readonly`; it does not request send, modify, or delete scopes.
- Connection metadata is keyed to the immutable Coke Dots Google user, not the active workspace. This lets the same account use its own authorized inbox across its workspaces while keeping a second Google account isolated.
- SQLite stores only the Gmail address, connection time, and allowed scope. The refresh token is stored under that Google user's Keychain entry; API responses, task records, task prompts, and Kubernetes configuration do not contain it.
- Gmail is queried only when the task instruction explicitly mentions email, Gmail, 邮件, 邮箱, or 收件箱. A bare `inbox` is deliberately insufficient because it can refer to Slack or another connector. The first version reads up to ten inbox messages, or a smaller explicit count, and may accept a Gmail query after `搜索邮件：` / `查找邮件：` / `查询邮件：`.
- Message data is labeled untrusted before it is added to the Agent prompt. The Agent kernel continues to run in the tenant's Debian cloud computer; the control plane performs the narrow Gmail read so the refresh token never enters the Pod.
- If the account has no Gmail connection or the authorization has expired, the task waits and tells the user to connect/reconnect Gmail.
- Disconnect deletes the local Keychain refresh token and connection metadata. It does not currently revoke the grant on Google's account-security page.

## Not implemented or not yet verified

- This branch implements explicit task-directed reading, not proactive Gmail polling or Google push notifications. The official docs support ongoing checks, but the exact Gmail event workflow and UI have not been observed. That follow-up should be its own feature branch after confirming whether to poll or use a supported event source.
- The Chrome E2E uses a local OAuth/Gmail fixture. It verifies click-through, requested scope, account isolation, task context, and disconnect behavior; it does not prove that the production Google OAuth app has passed Gmail-scope verification or that a real Gmail account is authorized.
- UI positions and interaction timing are not claimed to be pixel-accurate. The inspected official docs do not show the Gmail setup screen; match it only after collecting a clear reference frame.
