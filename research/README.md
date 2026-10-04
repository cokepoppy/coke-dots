# Dots reference evidence

Research date: 2026-10-05. This ledger separates product documentation, hands-on demonstrations, and a scripted launch film. A video index or written summary is a lead for review, not proof of pixels or behavior. No reference frame has been captured yet: YouTube denied the available download path with a bot challenge, and the browser automation session timed out. No component may be called pixel-matched until reference frames and comparison results exist.

## Source register

| ID | Source | Evidence class | Use |
| --- | --- | --- | --- |
| O1 | https://openai.com/index/introducing-dots/ | Official product description | Goals, continuity, computers, connected tools, controls |
| O2 | https://learn.chatgpt.com/docs/dots/getting-started | Official usage documentation | Setup and personalization flow |
| O3 | https://learn.chatgpt.com/docs/dots/tasks-and-memory | Official usage documentation | Activity, assigned work, background tasks, recurring work |
| O4 | https://learn.chatgpt.com/docs/dots/computers-and-apps | Official usage documentation | Computer view, Take over, Return control |
| O5 | https://learn.chatgpt.com/docs/dots/controls | Official usage documentation | Review, approval, pause, delegated task stop |
| V1 | https://www.youtube.com/watch?v=V_1Vn2WfpEY | Hands-on video; frames pending | Setup, conversation, delegation, scheduled tasks |
| V2 | https://www.youtube.com/watch?v=Q9tF0R8d_Co | Hands-on video; frames pending | Avatar, rename, cloud computer, call, parallel work |
| V3 | https://www.youtube.com/watch?v=uXspbC2srEQ | Scripted official film; frames pending | Visual leads only; do not infer runtime behavior |

The video chapter leads are from https://www.postcutoff.com/v/futurepedia-i-tested-openai-s-new-personal-assistant-agent-dots/ and https://madewithdots.com/projects/youtube-Q9tF0R8d_Co. They must be checked against the original videos before implementation claims depend on them.

## Interaction and state matrix

| Surface | Action | Expected state visible to user | Evidence | Visual reference |
| --- | --- | --- | --- | --- |
| Onboarding | Create dot; optionally connect apps and computer | Dot conversation available | O2 | Pending V1 01:18–02:46; V2 01:25–04:30 |
| Profile | Edit name, shape, color, eyes, glasses, accessories | Saved identity and updated handle | O2 | Pending V1 01:18–02:46; V2 02:14–07:12 |
| Conversation | Give ongoing responsibility and redirect it | Same dot continues with updated priorities | O3 | Pending V1 03:07–06:07 |
| Activity | Open a delegated task | Progress, files, result or request for input | O3, O5 | Pending V1 07:46–08:55 |
| Scheduled | Request recurring work; open Scheduled | Instructions, timing and destination visible | O3, O5 | Pending V1 09:28–10:11 |
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

## Replay scripts

- **Setup:** create dot → inspect default name and avatar → edit visible appearance controls → rename → reopen profile → confirm persistence.
- **Persistent work:** assign a goal → close UI → let worker progress → reopen → inspect Activity → redirect priority → verify task and result history.
- **Scheduled work:** request recurrence → inspect Scheduled details → run at the requested trigger → inspect notification → cancel future run.
- **Computer:** open work computer → inspect without control → Take over → perform a browser action → Return control → verify agent resumes.
- **Approval:** request a draft that would send or write externally → inspect pending decision → reject → confirm no external mutation → approve a separate action → inspect audit trail.
