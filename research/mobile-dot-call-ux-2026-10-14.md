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
