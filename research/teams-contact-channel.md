# Microsoft Teams contact channel

## Evidence

- OpenAI's [Dots channel documentation](https://learn.chatgpt.com/docs/dots/channels) lists Microsoft Teams as a contact method for a Dot and describes continuity across connected contact methods. Conversation content is not mirrored between channels by default, and private context needs permission before it is shared with another person.
- The bot uses the Bot Framework multi-tenant client-credentials flow at Microsoft's `botframework.com` authority. Register a multi-tenant bot app before configuring `TEAMS_BOT_APP_ID` and its app password.
- Microsoft documents message activities as the inbound bot message format in [Conversations with an Agent](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/conversation-basics).
- Microsoft requires Bot Connector requests to be validated against the OpenID metadata signing keys, issuer `https://api.botframework.com`, audience matching the registered Microsoft App ID, token validity, signature and a matching `serviceUrl`. See [Bot Connector authentication](https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-authentication?view=azure-bot-service-4.0).
- Proactive replies need a bot installed in the relevant context and a stored conversation reference or conversation ID, tenant ID and service URL. See [Send proactive messages](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages).
- The reviewed public Dots videos do not show a Teams setup screen, account-linking flow or Teams message exchange. The Teams setup modal in Coke Dots is therefore a functional extension, not a frame-measured visual replica.

## Coke Dots implementation

- The setup dialog creates a random 24-character one-use code bound to the signed-in Coke Dots member and active tenant. Only a SHA-256 hash and expiry are stored. The user sends `connect CODE` to the installed bot in a personal chat; the code expires after ten minutes and is consumed atomically.
- The inbound `/teams/messages` route verifies the Bot Connector bearer JWT with Microsoft-hosted metadata and keys. It rejects invalid issuer, audience, signature, validity period or `serviceUrl`. Bot app credentials are never returned through the API; the app password is read from macOS Keychain (with environment-variable fallback for managed deployments and isolated E2E tests).
- Only personal `msteams` message activities are queued. Group and channel activities are ignored. This keeps results in the one-to-one conversation and avoids assuming permission to expose private requests to a group.
- Linked external identities are keyed by both Microsoft tenant and AAD object ID, then joined to a Coke Dots tenant member. If an identity is linked to more than one Coke Dots tenant, the message is ignored as ambiguous. Activity deduplication keys include the Microsoft tenant and conversation so separate chats cannot suppress one another.
- Messages create durable tenant tasks. Once a task reaches a result, waiting state or failure, the service replies to the stored conversation with Bot Connector authentication. Delivery retries are bounded and failures become dead-letter events.
- Linking is currently limited to personal Coke Dots workspaces. Shared workspaces expose task history to their members; this guard prevents a private Teams chat from creating task content visible to other members. Tenant isolation still applies across each user's Coke Dots workspace.
- No Azure Bot registration, Teams app package or live Teams tenant credentials are present in this checkout. The feature remains disabled until `TEAMS_BOT_APP_ID` is configured and the app password is stored with `npm run teams:configure`. The bot's messaging endpoint must be reachable over HTTPS at `/teams/messages`.

## Verification limits

- `tests/teams.test.ts` generates signed RSA JWTs and validates signature, issuer, audience, expiry, `serviceUrl`, one-use linking, idempotency, private-chat-only routing and tenant isolation.
- `tests/e2e/ui.e2e.ts` clicks through the Coke Dots Teams setup dialog in Chrome, creates a link code, simulates the signed-in test user's one-to-one activity through an E2E-only local route, runs a model task, and verifies delivery through a local mock Bot Connector. The mock route is available only in `NODE_ENV=test` with `DOTS_E2E_AUTH=1` and on a loopback request. It is not a production authentication bypass.
- These tests do not install or exercise a Teams app, Microsoft-hosted OAuth/consent, Bot Connector delivery, or an external HTTPS tunnel. The setup dialog's pixels remain unverified against Dots footage.
