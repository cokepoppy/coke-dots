# Dots reference evidence

Research date: 2026-10-05. This ledger separates product documentation, hands-on demonstrations, and a scripted launch film. A video index or written summary is a lead for review, not proof of pixels or behavior. V1 was opened in local Chrome and inspected by navigating its chapter list. Full Chrome-window captures of eight player states (01:18, 02:46, 04:00, 05:07, 06:06, 06:26, 09:28, and 10:05), plus a crop of the 06:26 call view, are saved locally under the ignored `research/frames/` directory. The PNGs preserve the YouTube rendition and browser/player overlays; they are evidence of visible states, not clean source frames or CSS measurements. YouTube's transcript side panel remained on its loading spinner, so observations use the video and on-screen captions. No component may be called pixel-matched until stable reference frames and comparison results exist.

## Source register

| ID | Source | Evidence class | Use |
| --- | --- | --- | --- |
| O1 | https://openai.com/index/introducing-dots/ | Official product description | Goals, continuity, computers, connected tools, controls |
| O2 | https://learn.chatgpt.com/docs/dots/getting-started | Official usage documentation | Setup and personalization flow |
| O3 | https://learn.chatgpt.com/docs/dots/tasks-and-memory | Official usage documentation | Activity, assigned work, background tasks, recurring work |
| O4 | https://learn.chatgpt.com/docs/dots/computers-and-apps | Official usage documentation | Computer view, Take over, Return control |
| O5 | https://learn.chatgpt.com/docs/dots/controls | Official usage documentation | Review, approval, pause, delegated task stop |
| V1 | https://www.youtube.com/watch?v=V_1Vn2WfpEY | Hands-on video; reviewed in Chrome; eight full-window captures and one cropped player image saved locally (not tracked) | Setup, conversation, connected Scratchpad page, task delegation, voice call, generated outputs, Scheduled page and a visible failure; see [time-coded observations](futurepedia-v1-observations.md) |
| V2 | https://www.youtube.com/watch?v=Q9tF0R8d_Co | Hands-on video; reviewed at chapter points in local Chrome; sampled screenshots were inspected but are not persisted | Avatar setup, Slack setup gate, cloud computer and Take over affordance, calls, parallel work, outputs, proposed automations; see [time-coded observations](john-aspinall-v2-observations.md) |
| V3 | https://www.youtube.com/watch?v=uXspbC2srEQ | Scripted official film; frames pending | Visual leads only; do not infer runtime behavior |
| G1 | https://developers.google.com/identity/openid-connect/openid-connect | Google identity protocol | Stable `sub` identity and ID-token claims |
| G2 | https://developers.google.com/identity/protocols/oauth2/web-server | Google OAuth implementation guide | Authorization-code flow and state validation |
| G3 | https://developers.google.com/identity/protocols/oauth2/resources/best-practices | Google OAuth security guidance | PKCE for desktop clients and state checks |

The video chapter leads are from https://www.postcutoff.com/v/futurepedia-i-tested-openai-s-new-personal-assistant-agent-dots/ and https://madewithdots.com/projects/youtube-Q9tF0R8d_Co. They must be checked against the original videos before implementation claims depend on them.

## Coke Dots infrastructure decisions (not Dots feature evidence)

- Google accounts are keyed by the verified immutable `sub` claim; profile email remains mutable display/contact information (G1).
- Login uses an authorization-code exchange, one-time state bound to a browser cookie, PKCE, nonce validation, and verified ID-token claims (G1–G3).
- Each account gets a personal tenant. Workspace membership controls which tenant a session can select. Application data, Keychain model keys, task working directories, and computer browser profiles are tenant-scoped.
- This app remains loopback-only. The initial local deployment supports multiple Google accounts and workspaces on the same Mac; remote access needs its own HTTPS and network access review before enabling it.

## Interaction and state matrix

| Surface | Action | Expected state visible to user | Evidence | Visual reference |
| --- | --- | --- | --- | --- |
| Onboarding | Create dot; optionally connect apps and computer | Dot conversation available | O2 | V1 01:18–02:46 shows Chat/Work home and first dot conversation; no customization or connection flow shown |
| Profile | Edit identity and appearance | Saved identity and updated handle | O2 | V1 02:46 shows the user choosing “dot”; V2 02:14 shows the initial customization surface, and 08:29 shows “Dolly” in the chat/computer welcome screen. Exact appearance controls and save/reopen persistence are not legible or verified |
| Conversation | Give ongoing responsibility and redirect it | Same dot continues with updated priorities | O3 | V1 02:46 and 06:06 show greeting, task request, and a later instruction; exact persistence behavior is not demonstrated |
| Activity | Open a delegated task | Progress, files, result or request for input | O3, O5 | V1 06:06–09:28 shows a multi-tool request and returned outputs in conversation. V2 05:40 and 13:58 show a “Recent activity” area beside the dot/computer panels; detailed event navigation remains unverified |
| Scheduled | Request recurring work; search/open Scheduled; cancel future work | Searchable list, selected work details, cadence, time zone, end date, and cancellation | O3, O5 | V1 10:01–10:05 shows the Scheduled list, a monitoring item, suggested items, and a selected-chat failure. Coke Dots implements a searchable tenant-scoped list for recurring tasks and page watches, details, and cancel/pause controls. It supports interval, daily, and weekly local-time schedules; the videos do not show the create-schedule editor. The demo's chat-open failure is not reproduced as normal behavior. |
| Computer | Open computer; Take over; Return control | Control holder changes explicitly | O4 | V2 04:30 shows an isolated browser desktop with “Roger has control” and a “Take over” button; 12:15/12:38 show “Welcome back, Dolly” and a Take over affordance. The actual click and Return control transition are not shown in sampled frames |
| Controls | Pause main task; stop delegated task; cancel schedule | Distinct stopped scopes | O5 | Pending |
| Integrations | Open Slack setup | Workspace selection and authorization gate | V2 | 07:12 shows a “Set up Slack” modal asking which workspace to add Roger to and a “Select a workspace” control; OAuth/authorization completion is not shown |
| Calling | Start or resume a phone call | Call state and ongoing task context | V2 | 05:40 and 13:09 show a call interaction; precise call controls and post-call status require clearer source frames |
| Proactive suggestions | Review proposed automations | Suggestions remain distinct from active schedules | V2 | 14:25 shows a list titled “10 automations it suggested.” The demo does not show these being scheduled or an automation notification being delivered; the presenter says he did not receive a notification |

## Functional evidence and boundaries

- **Confirmed:** A dot tracks multiple responsibilities, can work between conversations, pause and wake to continue, delegate work, and take further direction during work (O3).
- **Confirmed:** The cloud computer has its own browser and sessions. Merely opening it does not take control; the user selects Take over and later Return control (O4).
- **Confirmed:** Background research of connected information is read-only; actions that affect accounts or share information pass action review and may require approval (O5).
- **Confirmed:** Pause of the main task, stopping a delegated task, and cancelling a schedule are separate controls (O5).
- **Unverified:** Exact layout, dimensions, typeface, animation, avatar assets, timings, mobile UI, and the detailed failure-state presentation. Do not invent these from prose.
- **Scripted film only:** The official launch video shows example outcomes. Treat them as product vision until verified in hands-on footage or docs.

## Frame and workflow capture protocol

1. Acquire the original publicly available video through a permitted playback or download path. Keep original video under `research/videos/` (git ignored). Record URL, duration, resolution and capture date in a local manifest.
2. For each chapter lead, watch the entire transition at normal speed, then inspect frames around each state change. Record exact timecodes and click or voice action, prior state, next state and any error.
3. Extract lossless PNG frames with `ffmpeg -ss <time> -i <video> -frames:v 1 research/frames/<source>-<time>.png`. Keep frames local; store source/timecode and measurements in a tracked ledger without redistributing video frames.
4. Measure viewport, visible control bounds, spacing, color samples and text styles only where frames are sharp enough. Mark clipped or compressed values unknown. Obtain more than one frame for animation states.
5. Capture our app at the same viewport and compare overlay, changed-pixel ratio and region-level differences. Require visual review for font antialiasing and video compression artifacts.
6. Replay the observed path, including failed steps, against a local build. A screenshot match does not establish workflow parity; a successful task does not establish visual parity.

V1's chapter titles and selected frames have been reviewed directly in Chrome. Eight full-window Chrome captures and a local-only crop of the 06:26 call screen, with timestamped observations, are recorded in [futurepedia-v1-observations.md](futurepedia-v1-observations.md). V2 has also been reviewed directly in Chrome at the sampled chapter points documented in [john-aspinall-v2-observations.md](john-aspinall-v2-observations.md); its screenshots were visually inspected but are not saved as files. Neither review replaces clean source-frame capture, reliable pixel measurements, or image comparison.

## Replay scripts

- **Setup:** create dot → inspect default name and avatar → edit visible appearance controls → rename → reopen profile → confirm persistence.
- **Persistent work:** assign a goal → close UI → let worker progress → reopen → inspect Activity → redirect priority → verify task and result history.
- **Scheduled work:** request recurrence → inspect Scheduled details → run at the requested trigger → inspect notification → cancel future run.
- **Computer:** open work computer → inspect without control → Take over → perform a browser action → Return control → verify agent resumes.
- **Approval:** request a draft that would send or write externally → inspect pending decision → reject → confirm no external mutation → approve a separate action → inspect audit trail.

## Local browser verification

`npm run test:e2e` exercises the Coke Dots interface with real Google Chrome clicks at a fixed 1440 × 1000 viewport. It saves app screenshots, per-account recordings, Playwright traces, and a run manifest under the ignored `artifacts/e2e/` directory. The Scheduled flow verifies search, selected task details, error visibility when an engine is unavailable, schedule cancellation, monitor-form open/close, and creation of a weekly task with a selected time zone and end date. After configuring a local test model, the browser test also waits for an interval task to complete twice automatically before cancelling it from Scheduled. Worker tests verify the next daily occurrence uses its selected time zone and survives a database reopen. Unit tests also cover daily/weekly next-run calculation, DST gaps, end-date behavior, and legacy interval migration. These artifacts verify our own page state and control flow; they do not establish visual parity with Dots. V1 screenshots are persisted locally, but reference frames have not been measured or compared with Coke Dots. The test sign-in fixture also does not validate Google's live OAuth screens or callback.
