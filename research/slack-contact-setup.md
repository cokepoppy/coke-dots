# Slack contact setup evidence

## Product evidence

- Official Dots documentation says the same Dot is reachable across connected contact methods, and users connect those methods from the Dot profile. It identifies Slack direct messages and channel mentions in threads as supported ways to contact the Dot. By default, the Dot replies to the user; sharing context from a private conversation with other people needs permission. Adding a Dot to a channel does not itself configure monitoring. Source: [Message your dot](https://learn.chatgpt.com/docs/dots/channels).
- In V2, the right side panel at 07:11–07:12 shows the active Dot, Call and Slack actions, its connected computer, Recent activity, and Outputs. A Chrome replay at 07:14 shows a “Set up Slack” modal. A second sample at 07:21 shows the same modal. The visible controls are a “Your dot in” workspace picker with ASPI displayed, “Select another,” the helper “Choose the workspace to add Roger to Slack,” a “Select a workspace” button, and a close control.
- The 07:14 and 07:21 states were directly viewed in the user's Chrome session. Separate PNGs were not retained. These are timestamp samples, not continuous frame-by-frame inspection. The trigger click, Slack OAuth consent, completed installation, and any inbound or outbound Slack message are not visible. Do not infer those steps from this modal.

## Implementation boundary

Coke Dots reproduces the workspace selection modal and implements a Slack OAuth v2 workspace installation flow with only the `chat:write` scope. OAuth state is one-use, ten-minute, and bound to the signed-in user and active tenant. Bot tokens are stored in macOS Keychain under a tenant-and-Slack-team-derived account name; SQLite stores only the installation metadata and granted scopes. Selecting a contact workspace is tenant-scoped, and only workspace owners or admins can connect or change it. A member can inspect the current shared selection.

The current implementation does not receive Slack Events API messages or send a Dot response. Therefore a completed OAuth installation and workspace selection are not a claim that Slack conversations work end to end. Adding the message bridge requires a separately verified event subscription and request-signature handling path. Slack's official OAuth documentation requires checking OAuth `state`, exchanging the one-time code, and storing tokens securely; the Events API must validate signed request bodies before processing messages. See [Slack OAuth v2](https://docs.slack.dev/authentication/installing-with-oauth/) and [Slack request verification](https://docs.slack.dev/authentication/verifying-requests-from-slack/).

## Verification

`npm run test:e2e` uses a local-only mock Slack OAuth provider. Chrome clicks through the modal, authorization redirect, mock approval, callback, workspace selection, and reopened selected state. It verifies that the token is absent from SQLite and API responses, a separate personal tenant sees no workspace, and a shared-workspace member cannot change the selection. This does not exercise a live Slack app or Slack's hosted consent page.
