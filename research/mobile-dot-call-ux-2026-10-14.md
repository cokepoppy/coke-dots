# Mobile Dot calling and chat experience

Date: 2026-10-14

## Evidence reviewed

- OpenAI's [Getting started with your dot](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot) says Dots are available in the ChatGPT mobile app and desktop browser, and explicitly says the mobile web experience is unsupported.
- The official [Meet dots guide](https://learn.chatgpt.com/docs/dots) describes messaging and calling a Dot from the desktop browser or mobile app. A call can continue while the user also types, and work assigned during a call continues after the call ends.
- The [Futurepedia hands-on video](https://www.youtube.com/watch?v=V_1Vn2WfpEY&t=410s), at about 06:50.9, shows a phone call surface with the Dot identity, call timer, and three controls aligned at the bottom: speaker, red end call, and mute. The retained frame measurement is in `research/comparisons/voice-call-mobile-v1-0650.json`; its coordinates are normalized to the video crop and are approximate because of video compression.
- The [John Aspinall walkthrough](https://www.youtube.com/watch?v=Q9tF0R8d_Co&t=340s), at about 05:40, shows a browser chat with the call affordance and the ongoing Dot conversation visible. It supports keeping the conversation and call entry in the chat context on desktop.

## Product decision

Mobile Chrome is a Coke Dots extension, not a claim that OpenAI ships an official mobile-web client. Keep sign-in in the same responsive browser application. On small screens, retain the Dot conversation as the main page, move global navigation to a bottom rail, expose Call in the conversation header, and keep chat text and task history available in the stream. Starting a call opens a full-screen phone-like surface with the Dot identity, status, elapsed time, live transcript/task state, speaker, end, and mute controls. Hanging up returns to chat; it does not cancel a task that was already assigned to the Agent.

The existing desktop compact floating call remains unchanged. Both layouts use the same microphone permission, speech/stream transport, Agent task dispatch, transcript, and owner-scoped call-session lifecycle. Mobile browser microphone access requires a secure context and the user's permission; browser/device capability differences remain visible as call status or errors.

## Acceptance evidence

The browser E2E should cover the mobile login layout, 390 px chat layout without horizontal overflow, conversation-header Call entry, call status and timer, exact speaker/end/mute order, toggle behavior, hangup persistence, and unchanged compact desktop call card. Playwright mobile viewport emulation validates responsive UI and application state; it is not evidence of physical Android/iOS microphone hardware behavior or a signed-in public VPS deployment.

## Follow-up verification

On 2026-10-14, the local Chrome E2E added a separate Chromium context with `isMobile`, touch input, a 390×844 CSS viewport, 3× device scale, and microphone permission. It opened the mobile login page, signed in through the E2E-only test control, verified the account in the mobile navigation drawer, opened the Dot conversation, started a call from its header, toggled mute, ended the call, and confirmed one ended owner-scoped call record. The full browser suite passed 43 steps. This does not exercise Google's live OAuth redirect, a physical phone's microphone/speaker, or a paid voice-provider connection; public deployment was not changed in this follow-up.

## Continue texting during a mobile call (2026-10-15)

The official [Message your dot](https://learn.chatgpt.com/docs/dots/channels) guide says a user can type messages while talking and that assigned work continues after hang-up. V2's 05:40 Chrome sample shows the conversation beside the Dot's profile context panel, but does not show this behavior on a phone. For Coke Dots mobile Chrome, the full-screen call now has a “聊天” action that collapses the same mounted call into a compact floating card; the conversation timeline and composer become available, and “返回通话” restores the phone screen. The voice call record and microphone transport remain active while text is sent. Text tasks created during a call stay in the root Dot timeline so subsequent recognized speech remains visible in the same stream. This is a responsive-web interaction choice; it is not presented as a measured official mobile-web screen.

The local mobile Chrome E2E clicks through full-screen call → collapse to chat → send text → verify the call record is still active → restore the same call → continue Chinese voice-to-Agent work. It checks that the three compact call controls and restore action are each at least 44 CSS pixels. The full suite passed 43 browser steps and 13 cloud-computer checks; `npm test` passed 84 unit tests. Screenshot: `artifacts/e2e/2026-10-14T16-16-19-245Z/screenshots/mobile-chrome-call-minimized-chat-390.png`.

These checks use mobile browser emulation and local mock OAuth/voice services. They do not verify a physical phone microphone, a live Google OAuth flow, or a paid public voice session.
