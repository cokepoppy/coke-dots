# Slack contact setup: evidence and implementation boundary

## Product evidence

- Official Dots documentation describes one Dot reachable through connected contact methods, including Slack direct messages and channel mentions. It says the Dot replies to the initiating user by default; sharing private conversation context with other people requires permission. Adding the Dot to a channel does not by itself configure channel monitoring. Source: [Message your dot](https://learn.chatgpt.com/docs/dots/channels).
- John Aspinall's V2 video (`Q9tF0R8d_Co`) was rechecked in Chrome on 2026-10-10. Around 07:11–07:12 the right panel shows the active Dot and its Slack action. At 07:15 the composite shows a “Set up Slack” modal, helper text “Choose the workspace to add Roger to Slack,” and “Add to Slack”; the workspace value is not legible in that frame. At 07:19, the same modal shows “Your dot in ASPI” and “Add to Slack,” with the pointer over the CTA. These are timestamp samples, not a continuous interaction recording.
- The video is compressed and composite. It supports the sampled labels, CTA, and broad modal layout, but not exact source-CSS pixel measurements. The click opening the modal, Slack's hosted consent, the OAuth callback, completed installation, and inbound/outbound Slack messages are not shown clearly. No original PNG frames were retained. Do not label these unseen transitions as video-verified or claim pixel-perfect measurements from the compressed frames.
- The installed Slack desktop app was inspected read-only to identify the local client. Its channel UI is Slack itself and is not evidence for Dots' Slack setup modal; no Slack message was sent or changed.

## Current implementation

Coke Dots reproduces the observed details-panel Slack action and workspace setup modal. The local OAuth v2 flow requests `chat:write`, uses one-time state bound to the signed-in user and active tenant, and stores the workspace bot token in macOS Keychain under a tenant-and-team-derived entry. SQLite stores installation metadata and scopes, not the token. Workspace selection is tenant scoped; only owners and admins can connect or change it. The CTA and ASPI selected-workspace state match the visible video samples. The empty-state workspace label is a functional placeholder; its exact text is not legible in the reference.

The video does not show how its authorization transition works. Coke Dots uses Slack OAuth v2 as an implementation choice: the first “Add to Slack” click begins the OAuth flow; after callback, the same modal shows the installed workspaces and “Add to Slack” links the selected workspace to the Dot. The local E2E's consent page is a mock and does not resemble or verify Slack's hosted consent screen.

This branch does **not** receive Slack Events API messages, create tasks from Slack messages, or send Dot responses to Slack. Selecting a workspace is not evidence that Slack conversations work end to end. A tenant-scoped signed event bridge is a separate feature and must verify Slack signatures, timestamps, identity bindings, event deduplication, and private delivery behavior before it is enabled. See [Slack OAuth v2](https://docs.slack.dev/authentication/installing-with-oauth/) and [Slack request verification](https://docs.slack.dev/authentication/verifying-requests-from-slack/).

## Verification

`npm run test:e2e` exercises a Chrome click-through using a loopback-only mock Slack OAuth provider: open the modal, start authorization, approve the mock consent, return through the callback, choose ASPI, and select it for Alpha. It verifies the token is held by the isolated E2E Keychain service and absent from the API and SQLite, confirms a separate Google tenant sees no installation, checks owner/member write permission, and captures light/dark modal screenshots. These checks cover local fixtures, not Slack's hosted page or a live Slack installation.
