# Dots reference evidence

Research date: 2026-10-05. This ledger separates product documentation, hands-on demonstrations, and a scripted launch film. A video index or written summary is a lead for review, not proof of pixels or behavior. V1 was opened and inspected in local Chrome by navigating its chapter list and viewing the player at the listed times. One cropped browser screenshot of the 06:26 player view is saved locally under the ignored `research/frames/` directory; other sampled states were visually inspected but are not persisted. YouTube's transcript side panel remained on its loading spinner, so observations use video frames and on-screen captions. No component may be called pixel-matched until stable reference frames and comparison results exist.

## Source register

| ID | Source | Evidence class | Use |
| --- | --- | --- | --- |
| O1 | https://openai.com/index/introducing-dots/ | Official product description | Goals, continuity, computers, connected tools, controls |
| O2 | https://learn.chatgpt.com/docs/dots/getting-started | Official usage documentation | Setup and personalization flow |
| O3 | https://learn.chatgpt.com/docs/dots/tasks-and-memory | Official usage documentation | Activity, assigned work, background tasks, recurring work |
| O4 | https://learn.chatgpt.com/docs/dots/computers-and-apps | Official usage documentation | Computer view, Take over, Return control |
| O5 | https://learn.chatgpt.com/docs/dots/controls | Official usage documentation | Review, approval, pause, delegated task stop |
| V1 | https://www.youtube.com/watch?v=V_1Vn2WfpEY | Hands-on video; reviewed in Chrome; one cropped player screenshot saved locally (not tracked) | Setup, conversation, task delegation, voice call, generated outputs, Scheduled page and a visible failure; see [time-coded observations](futurepedia-v1-observations.md) |
| V2 | https://www.youtube.com/watch?v=Q9tF0R8d_Co | Hands-on video; frames pending | Avatar, rename, cloud computer, call, parallel work |
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
| Profile | Edit name, shape, color, eyes, glasses, accessories | Saved identity and updated handle | O2 | V1 02:46 shows the user choosing the name “dot”; visual customization remains pending V2 02:14–07:12 |
| Conversation | Give ongoing responsibility and redirect it | Same dot continues with updated priorities | O3 | V1 02:46 and 06:06 show greeting, task request, and a later instruction; exact persistence behavior is not demonstrated |
| Activity | Open a delegated task | Progress, files, result or request for input | O3, O5 | V1 06:06–09:28 shows a multi-tool request and returned outputs in conversation; a dedicated Activity page remains pending |
| Scheduled | Request recurring work; open Scheduled | Instructions, timing and destination visible | O3, O5 | V1 10:01 shows the Scheduled list and a monitoring item; the selected chat visibly fails to open |
| Computer | Open computer; Take over; Return control | Control holder changes explicitly | O4 | Pending V2 04:30–05:40 |
| Controls | Pause main task; stop delegated task; cancel schedule | Distinct stopped scopes | O5 | Pending |

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

V1's chapter titles and selected frames have now been reviewed directly in Chrome. A local-only browser-captured crop of the 06:26 call screen and timestamped observations are recorded in [futurepedia-v1-observations.md](futurepedia-v1-observations.md). The crop documents a visible state but does not replace source-frame capture, measurements, or image comparison.

## Replay scripts

- **Setup:** create dot → inspect default name and avatar → edit visible appearance controls → rename → reopen profile → confirm persistence.
- **Persistent work:** assign a goal → close UI → let worker progress → reopen → inspect Activity → redirect priority → verify task and result history.
- **Scheduled work:** request recurrence → inspect Scheduled details → run at the requested trigger → inspect notification → cancel future run.
- **Computer:** open work computer → inspect without control → Take over → perform a browser action → Return control → verify agent resumes.
- **Approval:** request a draft that would send or write externally → inspect pending decision → reject → confirm no external mutation → approve a separate action → inspect audit trail.

## Local browser verification

`npm run test:e2e` exercises the Coke Dots interface with real Chrome clicks at a fixed 1440 × 1000 viewport. It saves app screenshots, per-account recordings, Playwright traces, and a run manifest under the ignored `artifacts/e2e/` directory. These artifacts verify our own page state and control flow; they do not establish visual parity with Dots. V1 has been reviewed in Chrome and one cropped screenshot is persisted, but reference frames have not been measured or compared with Coke Dots. The test sign-in fixture also does not validate Google's live OAuth screens or callback.
