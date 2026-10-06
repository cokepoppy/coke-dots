# Voice-call replica: evidence and limits

Updated 2026-10-06 on feature/voice-call-replica.

## Reference evidence

- **Official Dots channels documentation:** [Message or call your dot](https://learn.chatgpt.com/docs/dots/channels) says a user can call from the conversation (and the desktop app can call from the Dot profile), type while talking, and continue work already assigned after ending the call. It also says Dot-initiated calls were planned after launch.
- **V1, 06:26:** the Chrome/YouTube composite shows a phone-style call display, avatar and name, a 0:06 elapsed timer, and Speaker, End, and Mute controls. The user begins speaking. This is a compressed composite; it does not provide source CSS measurements or a clean native desktop frame.
- **V2, 05:40 and 13:09:** a call is in progress beside the Dot conversation and its computer/activity context. At 13:58 a call-ended status chip is visible. These samples do not expose a full connect/end transition or the speech service.

## Coke Dots behavior implemented

- The Dot details panel's Call action opens a floating call card with avatar, elapsed time, speaker toggle, mute toggle, and hang-up.
- Chrome's SpeechRecognition/webkitSpeechRecognition converts a final utterance into a task in the currently selected tenant. The normal composer stays available during the call.
- speechSynthesis reads a short acknowledgement when the speaker is on. Hang-up ends the call session but leaves its assigned task running.
- SQLite stores call owner, workspace, start/end time, and elapsed duration. It stores no audio or raw call transcript. The recognized request is retained through the normal task instruction and activity records.
- Speech recognition and speech synthesis remain browser-provided capabilities; a browser without recognition reports that typing is available. Microphone denial also leaves the text composer usable.

## Verification and remaining gaps

- npm test: 37 tests passed, including call-history durability and workspace/owner isolation.
- npm run test:e2e: 31 Chrome browser E2E steps passed. The voice path uses a deterministic in-page SpeechRecognition stub: it clicks Call, dispatches an utterance, waits until the model call is actively held, hangs up, releases the model, and verifies the task completes. It also checks mute/speaker controls, timer progression, typing during the call, and separate tenant histories.
- Local screenshots from that E2E run: artifacts/e2e/2026-10-06T10-22-56-802Z/screenshots/voice-call-light.png, voice-call-dark.png, and voice-call-task-running.png (ignored by Git). The screenshots show composer availability while the call card is open.
- The test does not validate a real microphone permission grant, live acoustic recognition, the browser's speech service, a streamed two-way voice model, Dot-initiated calls, or call-history UI. The acknowledgement is synthesized locally; model answers are not streamed back as speech. Those behaviors remain incomplete or unverified.
- The phone-style source frame is too compressed for pixel measurements. The Coke Dots card is an evidence-led first implementation, not a pixel-perfect claim.
