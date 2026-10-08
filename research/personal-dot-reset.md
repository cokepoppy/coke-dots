# Personal Dot reset: evidence and implementation boundary

Updated 2026-10-08.

## Official behavior

OpenAI's [Getting started with your dot](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot) describes opening the Dot profile menu, choosing Reset, reviewing a deletion notice, and confirming or cancelling. A successful reset deletes the Dot, its conversations, saved memories, and scheduled tasks, then returns to a new ChatGPT conversation to create a Dot again. The article presents reset as irreversible.

OpenAI's [Control your dot](https://learn.chatgpt.com/docs/dots/controls) also says that reset does not undo changes already made in connected apps or recall messages that were delivered. The public hands-on videos reviewed for this project do not demonstrate this flow. We therefore have official evidence for reset semantics, but no video frame for matching the dialog's exact layout, copy, or pixels.

## Coke Dots behavior

The Reset action is available only when the signed-in user owns a personal workspace with exactly one member. A shared workspace, a personal workspace with additional members, and a non-owner API request are rejected.

After the confirmation, Coke Dots stops active task and page-monitor work, closes the local computer, and clears that workspace's tasks and activity, schedules and watches, approvals, attachments, calls, notes, pages, rules, appearance profile, and per-Dot settings. Its local computer and agent runtime directories are removed after path/type checks. When the Linux desktop connector is configured, it deletes only a namespace carrying both the Coke Dots management label and the current tenant hash.

The Google account, personal workspace membership, model endpoint/name, and model API key in macOS Keychain are retained. These retention choices are specific to Coke Dots and are not claims about OpenAI Dots. External changes or messages already sent by an agent are not rolled back.

## Verification and limits

- `tests/reset-dot.test.ts` checks personal-data deletion, account/provider retention, and rejection of shared, multi-member, and non-owner resets.
- The Chrome E2E seeds tasks, a recurring schedule, memories, a page, a monitor, an attachment, and tenant runtime files. It captures the open confirmation dialog, verifies Cancel leaves state and files unchanged, confirms reset, checks cleanup and retained settings, verifies the first-run screen, and checks another tenant remains intact.
- `npm run test:e2e:k3d` passed on 2026-10-08 in the `tp1121-sandbox-dev` cluster. Chrome opened Dot settings and confirmed Reset for a fresh UUID personal workspace; the matching managed namespace was deleted, and all 9 namespaces present before the run remained. The confirmation screenshot is at `artifacts/e2e/k3d-cloud-computer-2026-10-08T15-27-48-196Z/06-personal-dot-reset-confirmation.png`. The same run verified Debian 13 desktop rendering, user takeover/return, remote browser navigation, Agent runtime dispatch, and task-workspace persistence after Pod recreation.
- `npm run test:e2e` uses a disposable test database and fake identities. It does not test Google's hosted OAuth consent UI.
- The K3D reset test uses a compact test-only memory request profile to fit the existing cluster capacity; production memory requests and limits are unchanged. Successful namespace deletion is verified, but recovery from a Kubernetes timeout remains unverified.
- The dialog is a locally designed confirmation surface informed by official reset semantics. No pixel-parity claim is made for this unobserved screen.
