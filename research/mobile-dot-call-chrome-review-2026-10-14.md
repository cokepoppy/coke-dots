# Coke Dots mobile Chrome: interaction evidence

Research date: 2026-10-14

## Scope and evidence

OpenAI's product overview says a Dot can be messaged or called from desktop, web, and mobile. The Dots getting-started documentation narrows the mobile surface: users can set up and open a Dot in the ChatGPT mobile app, while **mobile web is not supported**. Coke Dots in mobile Chrome is therefore a responsive web adaptation, not a pixel-for-pixel copy of an official mobile-web client.

Sources:

- [Introducing dots — OpenAI](https://openai.com/index/introducing-dots/): Dots can be messaged or called in ChatGPT on desktop, web, and mobile.
- [Get started with your dot — ChatGPT Learn](https://learn.chatgpt.com/docs/dots/getting-started): mobile setup and use are described for the ChatGPT mobile app; mobile web is explicitly unsupported.
- [Tasks and memory — ChatGPT Learn](https://learn.chatgpt.com/docs/dots/tasks-and-memory): assigned work persists across conversations; new cloud threads can be opened and steered in mobile apps.
- [Connect computers and apps — ChatGPT Learn](https://learn.chatgpt.com/docs/dots/computers-and-apps): a request can come from a phone while the Dot works on its cloud computer; computer access is distinct from the messaging channel.
- [Create your dot in the ChatGPT mobile app — ChatGPT Learn](https://learn.chatgpt.com/docs/whats-new/dots-october-9-2026): the official 38-second mobile setup video shows Dot avatar customization. Its companion product image shows a mobile conversation with a menu button, centered Dot identity, top-right Call action, message bubbles, and a composer.
- [ChatGPT Dot Hands-on: Chat, Voice Calls and a Connected Computer — YouTube](https://www.youtube.com/watch?v=GEC8c49OUXY): a five-minute desktop walkthrough by Chris K.C. At 01:00 it shows the chat stream beside the Dot details / Computers / Activity panel; at 02:00 it shows an active-call card with call status, mute, red hang-up, and ended-call entries in the conversation stream. It does not demonstrate mobile Chrome.

The YouTube video is compressed and does not demonstrate the mobile layout. The official mobile product image is the available phone-layout reference; mobile-web behavior itself remains an implementation decision.

## UX decision

1. Keep Google sign-in as a normal top-level browser redirect. The signed-in mobile surface must retain the same tenant and Dot conversation after login.
2. Make the Dot conversation the primary phone surface. Keep the conversation timeline and composer visible, including task updates and artifacts.
3. Use a compact phone header: navigation menu on the left, Dot/task identity in the center, and a touch-sized Call button on the right. Put Activity, Scheduled, Computer, Scratchpad, recent tasks, workspace selection, and account controls in a navigation drawer.
4. Starting Call from the Dot header opens the existing full-screen mobile call UI. Keep mute, speaker, status, and the single red hang-up action reachable. Ending the call returns to the same conversation; it does not cancel assigned work.
5. Other mobile pages keep bottom navigation. A user can return to Dot conversation from Activity, Scheduled, Computer, or account settings.
6. Honor phone safe areas and virtual-keyboard viewport resizing. Verify 390-pixel and narrow 320-pixel viewports.

## Landscape phone browser follow-up (2026-10-14)

The responsive shell and full-screen call are selected for narrow windows or touch-first screens up to 1024 CSS pixels wide. This keeps a phone in landscape mode on the same Dot conversation and handset call surface while preserving the compact floating call card for desktop Chrome at the same 690-pixel width. The local browser E2E checks the Google sign-in link target and touch size, starts a call in 390×844 mobile Chrome, rotates the viewport to 844×390, and asserts the phone call surface and all controls stay within the viewport. This is mobile viewport emulation, not a physical iOS/Android microphone or live Google sign-in test.

## Verification boundary

Local Playwright E2E uses the repository's isolated test server and test sign-in. It can prove responsive layout, click navigation, the Dot conversation, and call UI state. It does not prove physical phone Google OAuth, OS microphone permission, speech recognition, or live Pi dispatch; those require a signed-in mobile Chrome run against the deployed HTTPS site and must be reported separately.

## Mobile spoken-task round trip (2026-10-14)

The follow-up Chrome test uses a 390×844 phone context with touch, DPR 3, and a granted test microphone permission. It speaks a Chinese task request through a deterministic browser-recognition fixture; the Dot asks a Chinese clarification, the second utterance resumes the same persisted task, and the task is held in progress while the user hangs up. Releasing the test Agent after hangup completes that task and places its Chinese result in the same chat timeline. The test also records the active phone-call screen. The complete browser suite passed 43 steps and the cloud-computer E2E passed.

This is simulated speech/model input against the local isolated E2E server. It proves the phone layout, click path, transcript-to-task dispatch, clarification/resume, hangup persistence, and post-call completion. It does not prove physical-phone microphone capture, live speech-provider audio, Google OAuth against Google's servers, Pi execution on the VPS, or a public deployment. OpenAI's current [Dots guide](https://learn.chatgpt.com/docs/dots) says mobile web is unsupported, so Chrome support here remains Coke Dots' responsive-web adaptation.
