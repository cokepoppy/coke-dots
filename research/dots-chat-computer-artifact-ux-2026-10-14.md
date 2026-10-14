# Dots conversation, cloud computer, and generated-file UX

Reviewed: 2026-10-14. This note records the layout decision and file-delivery behavior implemented on `feature/chat-computer-artifact-delivery`.

## Evidence reviewed

| Source and sample | What it shows | Evidence limit |
| --- | --- | --- |
| [OpenAI: Connect computers and apps to your dot](https://learn.chatgpt.com/docs/dots/computers-and-apps), sections “Use the cloud computer” and “Cloud threads” | The profile's Computers entry opens a separate cloud-computer view. Opening the computer does not hand over control; Take over and Return control are explicit actions. The cloud computer owns its files and browser sessions. | Official written product behavior; it does not specify the exact responsive layout or every file-preview state. |
| [OpenAI: Tasks and memory](https://learn.chatgpt.com/docs/dots/tasks-and-memory), example around its task sidebar | The Dot profile context includes Computers, Recent activity, and Outputs. A task can be opened to inspect progress, files, results, or requests for input. | The page example is an illustration, not a CSS specification. |
| [John Aspinall hands-on video](https://www.youtube.com/watch?v=Q9tF0R8d_Co), 04:42–04:50 | At 04:42 a distinct browser desktop is visible with “Roger has control” and Take over. Around 04:50 the desktop remains while ownership changes to “You have control” and Return control. | Chrome/YouTube composite, compressed; it does not reveal source viewport or CSS pixels. Captures are documented in `research/john-aspinall-v2-observations.md`. |
| [John Aspinall hands-on video](https://www.youtube.com/watch?v=Q9tF0R8d_Co), 05:40 | The conversation remains on screen beside the right context panel. It contains Computers, Recent activity, and Outputs. | The exact width and pixel positions cannot be inferred from the composite. Capture: `research/frames/john-aspinall-v2-0540-chrome-live.png` (ignored by Git). |
| [Futurepedia hands-on video](https://www.youtube.com/watch?v=V_1Vn2WfpEY), 05:07 sample and 09:28 sample | The conversation can link a created Scratchpad page; later, generated visual outputs appear in the conversation and the user requests an edit. | The 05:07 sample offset is uncertain and both are compressed composites. They are interaction evidence, not pixel references. See `research/futurepedia-v1-observations.md`. |
| [OpenAI: Work with files](https://learn.chatgpt.com/docs/artifacts-viewer?surface=app) | The app can preview generated documents alongside chat; when HTML preview is available, HTML can be interactive and can be downloaded or refined. | This is general ChatGPT file guidance, not a claim that every Dots task currently produces the same preview. |

## Decision

Keep the conversation as the main surface and keep the Dot details panel at the right. Keep the cloud computer as a separate view entered from Computers. This matches the observed Dots structure and preserves the wider conversation while work continues. Opening the computer itself must not imply control; takeover and return remain visible, deliberate states.

Generated files need a direct handoff from the task result. A raw `/workspace/tasks/<id>/...` path is useful to an agent but not to a person: it does not open in the user's Chrome and forces them through the desktop file manager. The chat now lists files beside the selected task result, with:

- an in-chat preview for supported files, including interactive HTML;
- a download action for each listed file;
- an explicit “在云电脑中打开” action for HTML, which opens the same task file in that tenant's cloud Chrome and visibly hands control to the user;
- the existing Computers entry for watching the live desktop or taking over for other work.

The in-chat preview is rendered in a sandboxed iframe. A signed-in user receives a five-minute, read-only preview ticket bound to one tenant and task so relative HTML assets can load even though the iframe has an isolated origin. A signed-in browser for another tenant is rejected; the ticket does not expose a general workspace path. The cloud-browser action checks the tenant task and file before handing over control, then opens the file from the tenant workspace PVC.

## Verification target

Chrome E2E creates a cloud Agent task that returns an HTML file plus a relative JavaScript asset; selects the task from Recent; opens the preview; verifies that the linked script rendered Chinese output; opens the same HTML in the cloud computer; returns control; then signs in to a second tenant and verifies that listing, reading, and opening the first tenant's file all return 404. Worker tests cover bearer authentication, task-root traversal, symlink escape, missing output directories, and file-size bounds.

These references support the structural decision and artifact flow. They do not establish pixel parity: the reviewed videos are compressed browser composites and their original CSS viewport is unknown.
