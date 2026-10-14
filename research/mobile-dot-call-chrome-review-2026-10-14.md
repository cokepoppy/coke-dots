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

## Verification boundary

Local Playwright E2E uses the repository's isolated test server and test sign-in. It can prove responsive layout, click navigation, the Dot conversation, and call UI state. It does not prove physical phone Google OAuth, OS microphone permission, speech recognition, or live Pi dispatch; those require a signed-in mobile Chrome run against the deployed HTTPS site and must be reported separately.
