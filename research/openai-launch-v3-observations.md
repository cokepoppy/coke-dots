# OpenAI Dots launch film (V3) observations

Reviewed 2026-10-12 in Google Chrome. Source: [Introducing dots, always-on agents built to handle everything.](https://www.youtube.com/watch?v=uXspbC2srEQ), OpenAI's official channel. The player reports a duration of 2:27. The capture helper records the decoded video dimensions and hashes each local screenshot in `research/frames/v3-openai-launch-film/manifest.json`; generated frames are ignored and are not redistributed.

These are discrete time samples, not a frame-by-frame reconstruction. The clip is a scripted promotional film with staged phone and display scenes. It provides visual leads, while the hands-on V1/V2 videos and official product documentation remain the evidence for actual app behavior.

## Sampled scenes

| Source time | Direct observation | Evidence boundary |
| --- | --- | --- |
| 00:02 | Opening cinematic shot of a woman; no product UI. | Establishes film style only. |
| 00:58 | Close-up of a phone-like screen. A named Dot, “Jojo,” says it found an app migration in Google Meet notes and mapped changes. A user reply asks it to check every flow against the current product. | Text and visual framing are legible in the video, but this does not show an actual Dots app screen or a completed research workflow. |
| 01:08 | Cinematic close-up of the woman reacting. | No product control or task state visible. |
| 01:18 | Cinematic wide shot of the woman walking through a room. | No product control or task state visible. |
| 01:28 | A freestanding display shows a small, stylized shopping/video interface. | Most text and controls are too small or blurred to measure. It is not treated as the browser UI. |
| 01:38 | The woman works at a laptop. | The laptop UI is not legible. |
| 01:48 | A tall pink display appears in a staged outdoor scene. | No readable interaction or product state. |
| 01:58 | The woman holds a phone with a pink screen. | The screen content is too blurred to identify. |
| 02:08 | A stylized conversation screen names the Dot “Felipe.” The screen shows an edit request about putting consumer experience before growth figures, then a Dot message noting a finance review moved to the time of the user's daughter's recital and saying it will try to reschedule. | This portrays proactive conflict discovery in a scripted scene. It does not show the source/calendar UI, consent, approval, or whether a reschedule is actually performed. |
| 02:18 | A person looks at a phone in a cinematic shot. | Phone content is not legible. |
| 02:27 | The film ends and YouTube shows end cards. | End cards are platform UI, not Dots UI. |

## Implementation use

- Do not copy the staged pink screens or the miniature shopping interface as exact Coke Dots UI; there is no stable, legible source geometry.
- The 00:58 and 02:08 scenes reinforce the documented product direction: a Dot can review connected information, carry a request forward, and notice a scheduling conflict. The actual control sequence remains unobserved here.
- The 02:08 claim is a promotional scenario, not proof that calendar access, conflict detection, or automatic rescheduling is available in every Dots account. Preserve explicit user authorization and approval boundaries in Coke Dots.
- For pixel comparisons, use the readable hands-on V1/V2 frames and record unknowns when video compression, perspective, or blur obscures a value.

## Capture reproduction

Run `npm run research:capture-dot-v3`. The Playwright/Chrome helper opens the film at 00:02, 00:54, and 02:04, then captures the decoded video image at each listed timestamp while playback advances. It pauses only to save each screenshot; it does not repeatedly seek at every half-second sample. This avoids YouTube's media-source reload race observed at 01:07.5 and preserves the actual presented frame time. The local manifest records video duration and dimensions, requested and decoded time, image dimensions, byte length, image statistics, and SHA-256. The 79 captures are time samples every 0.5 seconds around the reviewed scenes, not every encoded video frame. The helper does not download or retain the video stream.
