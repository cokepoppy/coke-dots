# Voice-call replica: evidence and limits

Updated 2026-10-06 on feature/voice-call-task-continuity.

## Reference evidence

- **Official Dots channels documentation:** [Message or call your dot](https://learn.chatgpt.com/docs/dots/channels) says a user can call from the conversation (and the desktop app can call from the Dot profile), type while talking, and continue work already assigned after ending the call. It also says Dot-initiated calls were planned after launch.
- **Official task-flow documentation:** [Get started with your dot](https://learn.chatgpt.com/docs/dots/getting-started) says users can keep talking to the Dot to add context, change priorities, or make a decision without restarting work. The voice-specific clarification interaction is not shown in the available V1/V2 frames, so the behavior below is marked as documentation-backed and E2E-verified, not frame-measured.
- **V1, 06:26:** the Chrome/YouTube composite shows a phone-style call display, avatar and name, a 0:06 elapsed timer, and Speaker, End, and Mute controls. The user begins speaking. This is a compressed composite; it does not provide source CSS measurements or a clean native desktop frame.
- **V2, 05:40 and 13:09:** a call is in progress beside the Dot conversation and its computer/activity context. At 13:58 a call-ended status chip is visible. These samples do not expose a full connect/end transition or the speech service.

## Coke Dots behavior implemented

- The conversation composer phone button and Dot profile action open a floating call card with avatar, elapsed time, speaker toggle, mute toggle, and hang-up. The details panel also retains a Call action.
- Chrome's SpeechRecognition/webkitSpeechRecognition converts each final utterance into a normal task in the currently selected tenant. The text composer stays available during the call.
- When the task being followed reaches `waiting`, its ID is retained for the next final utterance. That utterance uses the existing tenant-scoped task-reply endpoint, resumes the same task with the original goal, and keeps the task ID. If the reply request fails, the waiting task ID is restored so the next utterance can retry it.
- While the call is open, the UI follows task state. Browser speech synthesis reads the queue acknowledgement and then the task's completed result or a question when the task is waiting. Recognition pauses during speech to avoid transcribing the Dot's own output.
- Hanging up ends the persisted call session and stops call UI polling/speech; the independent background task continues in the server worker.
- SQLite stores call owner, workspace, start/end time, and elapsed duration. It stores no audio or raw call transcript. The recognized request is retained through the normal task instruction and activity records.
- Speech recognition and speech synthesis remain browser-provided capabilities; a browser without recognition reports that typing is available. Microphone denial also leaves the text composer usable.

## Verification and remaining gaps

- `npm test`: 40 tests passed, including call-history durability and workspace/owner isolation. The store-level reply test also verifies that a waiting task resumes without losing its original goal.
- The Chrome UI E2E completed 31 browser steps. Its voice flow uses deterministic in-page speech input to create a waiting task, speak the Dot's question, answer “Use Friday.”, and assert that the same task ID reaches `done` with the model result and the user reply in its prompt. It also covers both call entry points, actual result speech, mute/speaker controls, timer progression, typing during a call, continuation after hang-up, and separate tenant histories. The cloud-computer E2E passed with remote runtime dispatch, takeover/return, and tenant token isolation.
- The voice test uses a deterministic in-page SpeechRecognition stub. A live microphone, acoustic recognition quality, and the browser's real speech service were not exercised. Speech is spoken after a task result or question arrives; this is not a streamed real-time voice model. Dot-initiated calls and a call-history UI remain unverified.
- Screenshots from the successful Chrome run are in the ignored `artifacts/e2e/2026-10-06T12-09-18-721Z/screenshots/` directory: `voice-call-waiting-for-clarification.png`, `voice-call-spoken-clarification-resumed.png`, and `voice-call-task-running.png`.
- The phone-style source frame is too compressed for pixel measurements. The Coke Dots card is an evidence-led first implementation, not a pixel-perfect claim.
