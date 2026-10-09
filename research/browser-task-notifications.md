# Browser task notifications

## Evidence

- OpenAI's Dots getting-started help says completion notifications can be configured, but does not show the settings surface or specify the available modes: https://help.openai.com/en/articles/20001530-getting-started-with-your-dot
- Dots task documentation describes telling Dot what merits an update and where to deliver it: https://learn.chatgpt.com/docs/dots/tasks-and-memory
- General ChatGPT notification documentation describes Never, background-only, and always modes, and requires browser or operating-system permission: https://learn.chatgpt.com/docs/notifications?surface=app&translationFallback=es-419. This is not Dots-specific evidence.

No reviewed Dots video demonstrates a browser notification permission prompt, its settings UI, or a notification click. Coke Dots uses the generic ChatGPT modes as an implementation choice. The exact Dots UI and notification delivery rules remain unverified.

## Coke Dots behavior

- Browser notification preference belongs to the signed-in Google account, so it follows that person between workspaces and does not leak to another member of the same shared workspace.
- Each task stores whether its creator requested a completion notification. A task waiting for a decision or failing always surfaces; routine completion may remain quiet. Scheduled unread results can also surface.
- Browser alerts contain a generic status message rather than task instructions or result text. Clicking one focuses Coke Dots and opens the originating task.
- Browser permission is requested when the user selects a mode other than Never. The server-side Mac notification preference remains a separate workspace setting.

## Verification

`tests/task-notifications.test.ts` checks ownership, quiet completion, mandatory attention alerts, recurring unread results, mode selection, and account preference persistence/isolation. The Chrome E2E in `tests/e2e/ui.e2e.ts` clicks through the preference selector, simulates browser permission, verifies foreground/background behavior, checks two Google accounts in a shared workspace, inspects alert content, and clicks an alert to return to its task. The browser test uses a local Notification API fixture; it does not verify native OS presentation or real browser permission prompts.

## Chinese demo recording

- Public playback: https://codex.cokeagent.com/dots-demo/demos/browser-task-notifications.webp
- The dedicated Chrome scenario is `tests/e2e/browser-task-notifications-demo.e2e.ts`. It shows the user enable background notifications, assign a read-only weekly release-readiness task, switch away while it runs, receive a generic completion notice, and click through to the result.
- Source recording, five screenshots, manifest, and decode report: `artifacts/demos/browser-task-notifications-2026-10-09T01-49-25-787Z/`.
- The animated WebP decodes fully in Chrome: 1,152×800, 237 frames, 19.96 seconds, 25 fps, 1× active playback, with four 2.5-second reading pauses. SHA-256: `5b58c3628fed67594673da70985c15d39e60f9263432fae985352d23b9993a0a`.
- The visible notification card is a labeled recorder preview for the browser Notification API. The E2E verifies the app invokes the API and binds its click to the task. Native macOS alert presentation, Google OAuth, and a live model-provider call are not part of this recording; the task result uses a deterministic local fixture.
